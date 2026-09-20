// Portal del huésped — ajustes que se guardan de verdad (Tanda L7 · lote L7-08).
//
// Cocoa 22 · ola 7 · lote 7-C (hosted in VentasAdicionalesTabs, tab «Portal del
// huésped»; pilot PropertySetupForms, template Formulario). Hasta L7-08 la
// pantalla guardaba marca, idiomas, ventanas y siete interruptores de
// «funciones visibles» SOLO en el estado de la página (recon L7 §8, CHK audit
// D13: no existe endpoint para nada de eso). Ahora ofrece únicamente lo que el
// API persiste en `PropertyCheckInPolicy` (services/guestPortalApi.ts →
// GET/PUT /properties/:id/check-in/policy):
//   · «Encuesta post-estancia»: activar + horas desde la salida (L7-04);
//   · «Pago en recepción»: cerrar el pre-check-in sin PSP (corrector CHK).
// El resto de la política (self check-in, verificación, depósito, asignación,
// bienvenida) sigue en /hoy/check-in-automatizado (enlace abajo). Lo que el
// huésped ve en el portal (español/inglés, folio real, facturas emitidas,
// peticiones, chat) se describe como información, no como ajustes.
// Permiso de guardado: guest_self_service.manage (misma regla que la pantalla
// de check-in automatizado: sin él, solo lectura). Sin estilos en línea.

import { useEffect, useState } from "react";
import type { PropertyCheckInPolicyDto } from "@hotelos/shared";
import { useTabHost } from "../tabs/TabHost";
import { useApiData } from "../../hooks/useApiData";
import { useActiveProperty } from "../../services/activeProperty";
import type { UpsellsDashboardKpis } from "../../services/upsellsApi";
import {
  GUEST_PORTAL_FORM_DEFAULTS,
  SURVEY_DELAY_MAX_HOURS,
  SURVEY_DELAY_MIN_HOURS,
  guestPortalPublicUrl,
  isPortalFormDirty,
  saveGuestPortalSettings,
  toPortalForm,
  validatePortalForm
} from "../../services/guestPortalApi";
import type { GuestPortalForm, GuestPortalFormErrors } from "../../services/guestPortalApi";
import { canManageCheckInPolicy } from "../operations/checkin-settings-view";
import { useNavGate } from "../../navigation/useEnabledModules";
import { navigateTo } from "../../lib/navigate";
import { useToast } from "../../components/Toast";
import { dateTime, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { LockIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaActionBar,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaPage,
  CocoaSkeleton,
  CocoaSpan,
  CocoaSwitch
} from "../../components/cocoa";
import { BRAND } from "../../config/brand";

/** Misma clave de caché que CheckInAutomationSettingsScreen: las dos pantallas leen la misma política. */
function policyPath(propertyId: string): string {
  return `/properties/${encodeURIComponent(propertyId)}/check-in/policy`;
}

export function GuestPortalSettingsScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { propertyId, propertyName } = useActiveProperty();
  const gate = useNavGate();
  const canManage = canManageCheckInPolicy(gate.grantedPermissions, gate.isPlatformAdmin);

  // Política real (GET); el formulario se rellena cuando llega y mientras no haya cambios sin guardar.
  const policyState = useApiData<PropertyCheckInPolicyDto>(policyPath(propertyId));
  const policy = policyState.data ?? null;
  const [form, setForm] = useState<GuestPortalForm>({ ...GUEST_PORTAL_FORM_DEFAULTS });
  // true desde la primera edición hasta guardar o revertir: mientras tanto una revalidación no pisa lo escrito.
  const [edited, setEdited] = useState(false);
  const [errors, setErrors] = useState<GuestPortalFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirty = edited && isPortalFormDirty(form, policy);

  useEffect(() => {
    if (policy && !edited) setForm(toPortalForm(policy));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy]);

  // Tanda 3 · CF-02: the upsell conversion KPI comes from the real dashboard
  // (Prisma UpsellImpression / GuestUpsellPurchase, last 30 days), not a constant.
  const upsells = useApiData<{ kpis: UpsellsDashboardKpis }>("/dashboards/upsells", { query: { propertyId } });
  const upsellKpis = upsells.data?.kpis ?? null;

  function set<K extends keyof GuestPortalForm>(key: K, value: GuestPortalForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setEdited(true);
    if (key === "postStaySurveyDelayHours") setErrors({});
  }

  function reset() {
    setForm(toPortalForm(policy));
    setEdited(false);
    setErrors({});
  }

  async function save() {
    if (!canManage || saving) return;
    const validation = validatePortalForm(form);
    setErrors(validation);
    if (Object.keys(validation).length > 0) {
      showToast("Revisa las horas de la encuesta antes de guardar.", { variant: "warning" });
      return;
    }
    setSaving(true);
    try {
      const saved = await saveGuestPortalSettings(propertyId, form);
      // Reconciliación con lo que devolvió el API (misma caché que /hoy/check-in-automatizado).
      await policyState.mutate(() => saved, async () => saved);
      setForm(toPortalForm(saved));
      setEdited(false);
      setSavedAt(saved.updatedAt ?? new Date().toISOString());
      showToast("Ajustes del portal guardados", { variant: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : STATUS_LABELS.saveError, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const openUpsells = () => navigateTo("UpsellsDashboard");
  const openCheckInPolicy = () => navigateTo("CheckInAutomationSettingsScreen");
  const publicUrl = guestPortalPublicUrl(BRAND.guestPortalHost, propertyId);

  return (
    <CocoaPage
      eyebrow={`Comercial · ${propertyName}`}
      title="Portal del huésped"
      subtitle={hosted ? undefined : "Encuesta post-estancia y pago en recepción: lo que el portal guarda de verdad. El resto de la política de check-in vive en Mi día › Check-in automatizado."}
      commands={[
        { id: "portal-huesped-guardar", label: "Guardar los ajustes del portal", run: () => void save(), shortcut: "⌘ Enter" },
        { id: "portal-huesped-checkin", label: "Abrir la política de check-in automatizado", run: openCheckInPolicy },
        { id: "portal-huesped-ventas", label: "Abrir el panel de ventas adicionales", run: openUpsells }
      ]}
    >
      {/* Dirección del portal (honesta: el host de la marca + ?property=; la base real de los enlaces la fija el servidor) y el único KPI real. */}
      <CocoaGrid aria-label="Dirección pública y resultados del portal" align="start">
        <CocoaSpan cols={8} min={480}>
          <CocoaCallout tone="info" title="Dirección del portal para este hotel">
            <code>{publicUrl}</code> · Los enlaces que reciben los huéspedes (invitación al pre-check-in, encuesta) los genera el servidor sobre la base
            configurada en <code>GUEST_WEB_BASE_URL</code>; sin proveedor de correo o WhatsApp el envío queda marcado como simulado en el recorrido
            del huésped.
          </CocoaCallout>
        </CocoaSpan>
        <CocoaSpan cols={4} min={240}>
          {upsells.loading && !upsellKpis ? (
            <CocoaSkeleton variant="kpi" />
          ) : (
            <CocoaKpi
              label="Conversión de ofertas"
              value={upsellKpis ? percent(upsellKpis.conversionRatePct, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—"}
              caption={
                upsellKpis
                  ? `${plural(upsellKpis.conversions30d, "conversión", "conversiones")} de ${plural(upsellKpis.offersShown30d, "impresión", "impresiones")} · ${plural(upsellKpis.activeOffers, "oferta activa", "ofertas activas")}`
                  : upsells.error ?? undefined
              }
              deltaLabel="últimos 30 días"
              polarity="neutral"
              status={upsells.error ? "warning" : "ok"}
              degraded={!upsellKpis}
              onClick={openUpsells}
            />
          )}
        </CocoaSpan>
      </CocoaGrid>

      {!canManage ? (
        <CocoaCallout tone="warning" title="Solo lectura">
          Guardar estos ajustes requiere el permiso «guest_self_service.manage».
        </CocoaCallout>
      ) : null}

      {policyState.error && !policy ? (
        <CocoaCallout tone="danger" title={STATUS_LABELS.loadError} role="alert" actions={<CocoaButton size="small" variant="bordered" tone="neutral" onClick={policyState.refresh}>{ACTIONS.retry}</CocoaButton>}>
          {policyState.error}
        </CocoaCallout>
      ) : null}

      {policyState.loading && !policy ? <CocoaSkeleton variant="card" height={220} /> : null}

      <CocoaFormSection
        title="Encuesta post-estancia"
        description="Tras la salida, el sistema envía por correo al titular (con consentimiento) un enlace a la encuesta del portal: NPS 0-10 y comentario. Las respuestas llegan a Reputación › Encuestas."
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Enviar la encuesta tras la salida" inline help={policy?.postStaySurveyEnabled ? STATUS_LABELS.enabled : STATUS_LABELS.disabled}>
            <CocoaSwitch checked={form.postStaySurveyEnabled} onChange={(v) => set("postStaySurveyEnabled", v)} size="small" disabled={!canManage || !policy} />
          </CocoaField>
          <CocoaField
            label="Horas desde la salida"
            help={`Desde las 00:00 del día de salida, hora del hotel (${SURVEY_DELAY_MIN_HOURS}-${SURVEY_DELAY_MAX_HOURS}; 24 = el día siguiente).`}
            error={errors.postStaySurveyDelayHours}
          >
            <CocoaInput
              value={form.postStaySurveyDelayHours}
              onChange={(v) => set("postStaySurveyDelayHours", v)}
              type="number"
              inputMode="numeric"
              min={SURVEY_DELAY_MIN_HOURS}
              max={SURVEY_DELAY_MAX_HOURS}
              step={1}
              disabled={!canManage || !policy || !form.postStaySurveyEnabled}
              error={Boolean(errors.postStaySurveyDelayHours)}
            />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection
        title="Pago en recepción"
        description="Sin pasarela de pago configurada, el huésped puede cerrar el pre-check-in con «se cobra en recepción». Recepción nunca queda bloqueada; el portal nunca marca un pago como hecho."
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Permitir «pago en recepción» al huésped" inline help={policy?.allowPayAtReception ? STATUS_LABELS.enabled : STATUS_LABELS.disabled}>
            <CocoaSwitch checked={form.allowPayAtReception} onChange={(v) => set("allowPayAtReception", v)} size="small" disabled={!canManage || !policy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      {/* Sin interruptores decorativos: lo que ve el huésped no es configurable por pantalla todavía; se dice tal cual. */}
      <CocoaCallout
        tone="neutral"
        title="Qué ve el huésped en el portal"
        actions={
          <CocoaButton size="small" variant="bordered" tone="neutral" onClick={openCheckInPolicy}>
            Política de check-in
          </CocoaButton>
        }
      >
        Español e inglés (selector en la cabecera), su estancia con el saldo real del folio, las facturas emitidas en PDF, las peticiones a
        recepción, el pre-check-in de seis pasos y el chat del recepcionista IA cuando el módulo «Autoservicio del huésped» está activo. Marca,
        colores, idiomas adicionales y qué bloques mostrar no se pueden configurar todavía desde aquí. Invitaciones, verificación de identidad,
        depósito y asignación se ajustan en Mi día › Check-in automatizado.
      </CocoaCallout>

      <CocoaCallout tone="neutral" icon={<LockIcon size={16} aria-hidden="true" />}>
        Los datos personales recogidos en el portal (documento, firma) se guardan cifrados por campo (extensión de Prisma del API) y solo el
        backend los descifra; la imagen del documento se lee y se descarta, no se almacena.
      </CocoaCallout>

      <CocoaActionBar
        aria-label="Acciones del portal del huésped"
        status={
          !canManage
            ? "Solo lectura"
            : dirty
              ? "Cambios sin guardar"
              : savedAt
                ? `${STATUS_LABELS.saved} a las ${time(savedAt)}`
                : policy?.updatedAt
                  ? `Última modificación ${dateTime(policy.updatedAt)}`
                  : undefined
        }
        primary={{ label: saving ? STATUS_LABELS.saving : ACTIONS.saveChanges, onClick: () => void save(), disabled: !canManage || !policy || !dirty || saving }}
        secondary={{ label: ACTIONS.revert, onClick: reset, disabled: !dirty || saving }}
        publishToastOffset
      />
    </CocoaPage>
  );
}

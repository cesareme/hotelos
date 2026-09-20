// Check-in automatizado · ajustes — pestaña /hoy/check-in-automatizado de Mi día
// (Tanda CHK · W4-B, docs/design/CHECKIN-AUTOMATIZADO-IA.md §8 fila «Ajustes»).
//
// Cuatro bloques sobre la política de la propiedad (`PropertyCheckInPolicy`,
// GET/PUT /properties/:id/check-in/policy):
//   · métricas §1.8 desde GET /properties/:id/check-in/arrivals (hoy y los
//     últimos 7 días: % pre-check-in completado, % invitadas, % con habitación
//     asignada, % llaves emitidas; sin llegadas se pinta «—», nunca 0 %);
//   · formulario controlado de la política (self check-in, invitación y
//     recordatorio, métodos de verificación, pago o garantía, asignación,
//     bienvenida y textos legales) con validación pura de
//     checkin-settings-view.ts y CocoaActionBar;
//   · pesos del motor de asignación con vista previa: «Probar con las llegadas
//     de mañana» lista las sugerencias existentes de mañana (el API no admite
//     una ejecución de solo lectura del lote: POST …/assignments/run escribe
//     AssignmentSuggestion, así que aquí no se llama);
//   · kioscos (GET/POST /properties/:id/kiosks, POST …/:id/pair): lista,
//     alta y «Emparejar», que muestra el código de 8 dígitos UNA sola vez.
// Permisos (useNavGate().grantedPermissions): guest_self_service.manage para
// guardar (sin él, solo lectura y aviso), kiosk.configure para el bloque de
// kioscos (sin él, aviso y sin llamadas). Sin estilos en línea (pantalla nueva).
// Hospedada en MiDiaTabs: el contenedor pinta la cabecera; `CocoaPage.title`
// se mantiene por contrato.

import { useEffect, useMemo, useState } from "react";
import type { KioskDeviceDto, PropertyCheckInPolicyDto } from "@hotelos/shared";
import { useTabHost } from "../tabs/TabHost";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { createKiosk as createKioskApi, pairKiosk as pairKioskApi, putPolicy, type CheckInPolicyPatch } from "../../services/checkinApi";
import { useActiveProperty } from "../../services/activeProperty";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useToast } from "../../components/Toast";
import { date, dateTime, number, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { LockIcon } from "../../components/cocoa-icons/StatusIcons";
import { preCheckInStatus } from "./frontdesk-labels";
import {
  ASSIGNMENT_WEIGHT_RULES,
  AUTO_ASSIGN_LEVEL_OPTIONS,
  DAYS_MAX,
  DAYS_MIN,
  DEPOSIT_POLICY_OPTIONS,
  KIOSK_FORM_DEFAULTS,
  VERIFICATION_METHOD_OPTIONS,
  WELCOME_CHANNEL_OPTIONS,
  canConfigureKiosks,
  canManageCheckInPolicy,
  computeArrivalMetrics,
  isoDayOffset,
  kioskCapabilitiesLabel,
  kioskStatusLabel,
  lastDays,
  metricPctLabel,
  toKioskCreateBody,
  toPolicyForm,
  toPolicyPatch,
  toggleInList,
  validateKioskForm,
  validatePolicyForm,
  weightRange,
  type ArrivalMetricInput,
  type ArrivalMetrics,
  type KioskForm,
  type PolicyForm,
  type PolicyFormErrors
} from "./checkin-settings-view";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaStatusBadge,
  CocoaStepper,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const SETTINGS_STALE_MS = 30_000;
const METRICS_DAYS = 7;

/** `ArrivalDto` de checkin-session.service.ts (lo que la pantalla usa). */
type ArrivalItem = ArrivalMetricInput & {
  reservationId: string;
  code: string;
  arrivalDate: string;
  eta: string | null;
  assignedRoomNumber: string | null;
  primaryGuest: { firstName: string; surname1: string | null } | null;
  preCheckIn: { sessionId: string; status: string; completedGuests: number; totalGuests: number; etaDeclared: string | null } | null;
  suggestion: { id: string; status: string; topRoomId: string | null; topRoomNumber: string | null; confidence: number; createdAt: string } | null;
};

type ArrivalsResponse = { date: string; items: ArrivalItem[] };

type MetricsState = { loading: boolean; error: string | null; today: ArrivalMetrics | null; week: ArrivalMetrics | null };

type PairingState = { deviceId: string; name: string; code: string; expiresAt: string };

function pctLabel(value: number | null): string {
  return metricPctLabel(value, (v) => percent(v, { maximumFractionDigits: 0 }));
}

function SettingsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} label="Cargando métricas…" />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export function CheckInAutomationSettingsScreen() {
  // Hospedada en MiDiaTabs: el contenedor pinta la cabecera.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { propertyId, propertyName } = useActiveProperty();
  const gate = useNavGate();
  const canManage = canManageCheckInPolicy(gate.grantedPermissions, gate.isPlatformAdmin);
  const canKiosk = canConfigureKiosks(gate.grantedPermissions, gate.isPlatformAdmin);

  // ---------------------------------------------------------------- política
  const policyState = useApiData<PropertyCheckInPolicyDto>(`/properties/${encodeURIComponent(propertyId)}/check-in/policy`, { staleTime: SETTINGS_STALE_MS });
  const [form, setForm] = useState<PolicyForm>(() => toPolicyForm(null));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<PolicyFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (policyState.data && !dirty) setForm(toPolicyForm(policyState.data));
  }, [policyState.data, dirty]);

  function set<K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }
  function setWeight(key: string, value: string) {
    setForm((prev) => ({ ...prev, weights: { ...prev.weights, [key]: value } }));
    setDirty(true);
  }

  async function save() {
    if (!canManage) return;
    const found = validatePolicyForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      showToast("Revisa los campos marcados antes de guardar.", { variant: "warning" });
      return;
    }
    setSaving(true);
    try {
      const saved = await putPolicy(propertyId, toPolicyPatch(form) as CheckInPolicyPatch);
      setForm(toPolicyForm(saved));
      setDirty(false);
      setSavedAt(saved.updatedAt || new Date().toISOString());
      policyState.refresh();
      showToast("Política de check-in guardada", { variant: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : STATUS_LABELS.saveError, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setForm(toPolicyForm(policyState.data));
    setErrors({});
    setDirty(false);
  }

  // ---------------------------------------------------------------- métricas §1.8 (hoy y 7 días)
  const days = useMemo(() => lastDays(new Date(), METRICS_DAYS), []);
  const today = days[days.length - 1];
  const [metrics, setMetrics] = useState<MetricsState>({ loading: true, error: null, today: null, week: null });
  useEffect(() => {
    let alive = true;
    setMetrics((prev) => ({ ...prev, loading: true, error: null }));
    Promise.all(days.map((day) => apiRequest<ArrivalsResponse>(`/properties/${encodeURIComponent(propertyId)}/check-in/arrivals`, { query: { date: day } })))
      .then((responses) => {
        if (!alive) return;
        const week = responses.flatMap((response) => response.items ?? []);
        const todayItems = responses[responses.length - 1]?.items ?? [];
        setMetrics({ loading: false, error: null, today: computeArrivalMetrics(todayItems), week: computeArrivalMetrics(week) });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setMetrics({ loading: false, error: err instanceof Error ? err.message : STATUS_LABELS.loadError, today: null, week: null });
      });
    return () => {
      alive = false;
    };
  }, [propertyId, days]);

  // ---------------------------------------------------------------- vista previa (llegadas de mañana con su sugerencia)
  const tomorrow = isoDayOffset(new Date(), 1);
  const [previewWanted, setPreviewWanted] = useState(false);
  const previewState = useApiData<ArrivalsResponse>(previewWanted ? `/properties/${encodeURIComponent(propertyId)}/check-in/arrivals?date=${tomorrow}` : null, { staleTime: SETTINGS_STALE_MS });
  const previewColumns: CocoaTableColumn<ArrivalItem>[] = [
    { key: "code", label: "Reserva", render: (row) => <strong>{row.code}</strong> },
    { key: "guest", label: "Huésped", render: (row) => (row.primaryGuest ? `${row.primaryGuest.firstName} ${row.primaryGuest.surname1 ?? ""}`.trim() : <span className="cocoa-note">Sin titular</span>) },
    { key: "eta", label: "ETA", render: (row) => row.preCheckIn?.etaDeclared ?? row.eta ?? <span className="cocoa-note">—</span>, hideOnNarrow: true },
    {
      key: "room",
      label: "Habitación",
      render: (row) =>
        row.assignedRoomNumber ? (
          <strong>{row.assignedRoomNumber}</strong>
        ) : row.suggestion?.topRoomNumber ? (
          <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false} title={`Confianza ${percent(Math.round(row.suggestion.confidence * 100))}`}>
            Sugerida {row.suggestion.topRoomNumber} · {percent(Math.round(row.suggestion.confidence * 100))}
          </CocoaBadge>
        ) : (
          <span className="cocoa-note">Sin sugerencia</span>
        )
    },
    { key: "precheckin", label: "Pre-check-in", render: (row) => <CocoaStatusBadge entry={preCheckInStatus(row.preCheckIn?.status ?? "not_invited")} dense /> }
  ];

  // ---------------------------------------------------------------- kioscos
  const kiosksState = useApiData<KioskDeviceDto[]>(canKiosk ? `/properties/${encodeURIComponent(propertyId)}/kiosks` : null, { staleTime: SETTINGS_STALE_MS });
  const kiosks = kiosksState.data ?? [];
  const [kioskForm, setKioskForm] = useState<KioskForm>({ ...KIOSK_FORM_DEFAULTS });
  const [kioskError, setKioskError] = useState<string | null>(null);
  const [kioskBusy, setKioskBusy] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);

  async function createKiosk() {
    const found = validateKioskForm(kioskForm);
    setKioskError(found.name ?? null);
    if (found.name) return;
    setKioskBusy("create");
    try {
      const device = await createKioskApi(propertyId, toKioskCreateBody(kioskForm));
      setKioskForm({ ...KIOSK_FORM_DEFAULTS });
      kiosksState.refresh();
      showToast(`Kiosco «${device.name}» creado: empareja la tablet para activarlo`, { variant: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo crear el kiosco.", { variant: "error" });
    } finally {
      setKioskBusy(null);
    }
  }

  async function pairKiosk(device: KioskDeviceDto) {
    setKioskBusy(device.id);
    try {
      const result = await pairKioskApi(propertyId, device.id);
      // El API (kiosk.service.ts startPairing) devuelve `code` (corrector SEC-10: contrato, tipo y pantalla con la misma forma).
      const code = result.code;
      if (!code) throw new Error("El API no devolvió el código de emparejamiento.");
      // El código se enseña una sola vez (el API guarda solo su hash); cerrar el aviso lo pierde.
      setPairing({ deviceId: device.id, name: device.name, code, expiresAt: result.expiresAt });
      kiosksState.refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo generar el código de emparejamiento.", { variant: "error" });
    } finally {
      setKioskBusy(null);
    }
  }

  const kioskColumns: CocoaTableColumn<KioskDeviceDto>[] = [
    { key: "name", label: "Kiosco", render: (row) => <strong>{row.name}</strong> },
    {
      key: "status",
      label: "Estado",
      render: (row) => (
        <CocoaBadge tone={row.status === "online" ? "success" : row.status === "disabled" ? "danger" : row.status === "offline" ? "warning" : "neutral"} size="small">
          {kioskStatusLabel(row.status)}
        </CocoaBadge>
      )
    },
    { key: "paired", label: "Emparejado", render: (row) => (row.paired ? (row.pairedAt ? date(row.pairedAt, "short") : STATUS_LABELS.yes) : <span className="cocoa-note">{row.pairingExpiresAt ? `Código válido hasta ${time(row.pairingExpiresAt)}` : STATUS_LABELS.no}</span>) },
    { key: "capabilities", label: "Periféricos", render: (row) => <span className="cocoa-note">{kioskCapabilitiesLabel(row.capabilities)}</span>, hideOnNarrow: true },
    { key: "lastSeen", label: "Último latido", render: (row) => (row.lastSeenAt ? dateTime(row.lastSeenAt) : <span className="cocoa-note">—</span>), hideOnNarrow: true }
  ];

  // ---------------------------------------------------------------- render
  const policyLoading = policyState.loading && !policyState.data;
  const commands = canManage ? [{ id: "checkin-auto-guardar", label: "Guardar la política de check-in", run: () => void save(), shortcut: "⌘ Enter" }] : [];

  return (
    <CocoaPage
      eyebrow={`Hoy · ${propertyName}`}
      title="Check-in automatizado"
      subtitle={hosted ? undefined : "Política del check-in en línea, pesos del motor de asignación, kioscos y métricas del módulo."}
      state={policyLoading ? "loading" : policyState.error && !policyState.data ? "error" : "ready"}
      skeleton={<SettingsSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: policyState.error ?? undefined, onRetry: policyState.refresh }}
      commands={commands}
    >
      {!canManage ? (
        <CocoaCallout tone="neutral" role="status" icon={<LockIcon size={16} aria-hidden="true" />} title="Solo lectura">
          Ver la política requiere «guest_self_service.read»; para cambiarla hace falta «guest_self_service.manage» (jefatura de recepción o dirección).
        </CocoaCallout>
      ) : null}

      {/* Métricas §1.8: hoy y los últimos 7 días desde las llegadas; sin llegadas «—». */}
      <CocoaSection title="Métricas del módulo" meta={<span className="cocoa-note">{metrics.loading ? STATUS_LABELS.loading : `Hoy y ${plural(METRICS_DAYS, "día", "días")} · ${date(days[0], "dayMonth")} → ${date(today, "dayMonth")}`}</span>}>
        {metrics.error ? (
          <CocoaCallout tone="warning" role="status">
            {metrics.error}
          </CocoaCallout>
        ) : metrics.loading && !metrics.today ? (
          <CocoaSkeleton.Strip count={4} label="Cargando métricas…" />
        ) : (
          <CocoaKpiStrip aria-label="Métricas del check-in automatizado">
            <CocoaKpi label="Pre-check-in completado hoy" value={pctLabel(metrics.today?.preCheckInPct ?? null)} caption={metrics.today ? `${number(metrics.today.preCheckInCompleted)} de ${plural(metrics.today.arrivals, "llegada", "llegadas")}` : undefined} deltaLabel={`7 días: ${pctLabel(metrics.week?.preCheckInPct ?? null)}`} polarity="neutral" status="ok" degraded={!metrics.today || metrics.today.arrivals === 0} />
            <CocoaKpi label="Invitadas" value={pctLabel(metrics.today?.invitedPct ?? null)} caption={metrics.today ? `${number(metrics.today.invited)} con sesión de pre-check-in` : undefined} deltaLabel={`7 días: ${pctLabel(metrics.week?.invitedPct ?? null)}`} polarity="neutral" status="ok" degraded={!metrics.today || metrics.today.arrivals === 0} />
            <CocoaKpi label="Con habitación asignada" value={pctLabel(metrics.today?.assignedPct ?? null)} caption={metrics.today ? `${number(metrics.today.assigned)} asignadas` : undefined} deltaLabel={`7 días: ${pctLabel(metrics.week?.assignedPct ?? null)}`} polarity="neutral" status="ok" degraded={!metrics.today || metrics.today.arrivals === 0} />
            <CocoaKpi label="Llaves sin recepción" value={pctLabel(metrics.today?.keysPct ?? null)} caption={metrics.today ? `${number(metrics.today.keysSigned)} firmadas · ${number(metrics.today.keysIssued - metrics.today.keysSigned)} QR de demo (sin certificado: la tarjeta se recoge en recepción)` : undefined} deltaLabel={`7 días: ${pctLabel(metrics.week?.keysPct ?? null)}`} polarity="neutral" status="ok" degraded={!metrics.today || metrics.today.arrivals === 0} />
          </CocoaKpiStrip>
        )}
      </CocoaSection>

      {/* Política: formulario controlado; los cambios no se guardan hasta «Guardar». */}
      <CocoaFormSection title="Self check-in" description="Invitación y recordatorio antes de la llegada, y cómo se verifica la identidad en línea.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Self check-in activo" inline help="El huésped completa viajeros, documento, firma y pago desde el portal.">
            <CocoaSwitch checked={form.selfCheckInEnabled} onChange={(v) => set("selfCheckInEnabled", v)} size="small" disabled={!canManage} />
          </CocoaField>
          <CocoaField label="Cotejo visual obligatorio en el kiosco" inline help="El kiosco deriva al mostrador si nadie coteja el documento.">
            <CocoaSwitch checked={form.requireVisualCheckAtKiosk} onChange={(v) => set("requireVisualCheckAtKiosk", v)} size="small" disabled={!canManage} />
          </CocoaField>
          <CocoaField label="Invitar (días antes de la llegada)" error={errors.inviteDaysBefore}>
            <CocoaStepper value={form.inviteDaysBefore} onChange={(v) => set("inviteDaysBefore", v)} min={DAYS_MIN} max={DAYS_MAX} size="small" disabled={!canManage} error={Boolean(errors.inviteDaysBefore)} />
          </CocoaField>
          <CocoaField label="Recordatorio (días antes de la llegada)" error={errors.reminderDaysBefore}>
            <CocoaStepper value={form.reminderDaysBefore} onChange={(v) => set("reminderDaysBefore", v)} min={DAYS_MIN} max={DAYS_MAX} size="small" disabled={!canManage} error={Boolean(errors.reminderDaysBefore)} />
          </CocoaField>
          <CocoaField label="Métodos de verificación admitidos" fullWidth error={errors.allowedVerificationMethods}>
            <div className="cocoa-cluster" role="group" aria-label="Métodos de verificación admitidos">
              {VERIFICATION_METHOD_OPTIONS.map((option) => {
                const selected = form.allowedVerificationMethods.includes(option.value);
                return (
                  <CocoaButton key={option.value} variant={selected ? "tinted" : "bordered"} tone={selected ? "accent" : "neutral"} size="small" aria-pressed={selected} disabled={!canManage} onClick={() => set("allowedVerificationMethods", toggleInList(form.allowedVerificationMethods, option.value))}>
                    {option.label}
                  </CocoaButton>
                );
              })}
            </div>
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Pago o garantía" description="Qué se cobra o garantiza antes de llegar; sin PSP configurado el pago pasa a recepción.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Política de depósito" help={DEPOSIT_POLICY_OPTIONS.find((option) => option.value === form.depositPolicy)?.help}>
            <CocoaSelect value={form.depositPolicy} onChange={(v) => set("depositPolicy", v as PolicyForm["depositPolicy"])} options={DEPOSIT_POLICY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} disabled={!canManage} size="small" />
          </CocoaField>
          <CocoaField label="Importe fijo (EUR)" error={errors.depositAmount} hint={form.depositPolicy === "fixed" ? STATUS_LABELS.required : STATUS_LABELS.optional}>
            <CocoaInput value={form.depositAmount} onChange={(v) => set("depositAmount", v)} inputMode="decimal" placeholder="120.00" disabled={!canManage || form.depositPolicy !== "fixed"} error={Boolean(errors.depositAmount)} size="small" />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Asignación de habitación" description="Cuánto decide el motor por su cuenta y qué habitaciones puede proponer.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Nivel de automatización" help={AUTO_ASSIGN_LEVEL_OPTIONS.find((option) => option.value === form.autoAssignLevel)?.help}>
            <CocoaSelect value={form.autoAssignLevel} onChange={(v) => set("autoAssignLevel", v as PolicyForm["autoAssignLevel"])} options={AUTO_ASSIGN_LEVEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} disabled={!canManage} size="small" />
          </CocoaField>
          <CocoaField label="Solo habitaciones inspeccionadas" inline help="Sin inspección por pisos, la habitación no se propone.">
            <CocoaSwitch checked={form.requireInspectedRoom} onChange={(v) => set("requireInspectedRoom", v)} size="small" disabled={!canManage} />
          </CocoaField>
          <CocoaField label="Proponer mejoras de tipo" inline help="Un tipo superior solo cuando no queda del reservado.">
            <CocoaSwitch checked={form.allowUpgradeSuggestion} onChange={(v) => set("allowUpgradeSuggestion", v)} size="small" disabled={!canManage} />
          </CocoaField>
          <CocoaField label="Walk-in desde el kiosco" inline help="Permite crear la reserva en el kiosco sin reserva previa.">
            <CocoaSwitch checked={form.allowWalkIn} onChange={(v) => set("allowWalkIn", v)} size="small" disabled={!canManage} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Pesos del motor de asignación" description="Vacío = peso por defecto del motor. Las bonificaciones van de 0 a 100 y las penalizaciones de −100 a 0.">
        <CocoaFormRow columns={2}>
          {ASSIGNMENT_WEIGHT_RULES.map((rule) => {
            const range = weightRange(rule.key);
            const error = errors[`weights.${rule.key}`];
            return (
              <CocoaField key={rule.key} label={rule.label} help={`${rule.help} Por defecto ${rule.defaultValue}.`} error={error}>
                <CocoaInput value={form.weights[rule.key] ?? ""} onChange={(v) => setWeight(rule.key, v)} inputMode="numeric" placeholder={String(rule.defaultValue)} min={range.min} max={range.max} step={1} disabled={!canManage} error={Boolean(error)} size="small" aria-label={`Peso de ${rule.label}`} />
              </CocoaField>
            );
          })}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaSection
        title="Vista previa · llegadas de mañana"
        meta={<span className="cocoa-note">{date(tomorrow, "dayMonth")}</span>}
        action={
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => (previewWanted ? previewState.refresh() : setPreviewWanted(true))} disabled={previewWanted && previewState.isValidating}>
            Probar con las llegadas de mañana
          </CocoaButton>
        }
      >
        {!previewWanted ? (
          <span className="cocoa-note">Muestra las llegadas de mañana con la habitación que el motor ya ha propuesto (lote de la tarde) y su estado de pre-check-in. El API no ejecuta el lote en modo lectura, así que la vista previa no reasigna nada.</span>
        ) : previewState.loading && !previewState.data ? (
          <CocoaSkeleton variant="row" lines={3} />
        ) : previewState.error ? (
          <CocoaState kind="error" inline title={STATUS_LABELS.loadError} message={previewState.error} onRetry={previewState.refresh} />
        ) : (previewState.data?.items.length ?? 0) === 0 ? (
          <CocoaState kind="empty" inline title="Sin llegadas mañana" message="Cuando haya reservas confirmadas con entrada mañana aparecerán aquí con su sugerencia." />
        ) : (
          <CocoaTable columns={previewColumns} rows={previewState.data?.items ?? []} rowKey="reservationId" caption="Llegadas de mañana con su sugerencia" density="compact" />
        )}
      </CocoaSection>

      <CocoaFormSection title="Bienvenida y textos" description="Orden de canales del mensaje de bienvenida y textos de consentimiento que ve el huésped.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Canales de bienvenida (en orden)" fullWidth error={errors.welcomeChannelOrder} help="Pulsa en el orden en que quieres intentarlos; el primero disponible gana.">
            <div className="cocoa-cluster" role="group" aria-label="Canales de bienvenida">
              {WELCOME_CHANNEL_OPTIONS.map((option) => {
                const position = form.welcomeChannelOrder.indexOf(option.value);
                const selected = position >= 0;
                return (
                  <CocoaButton key={option.value} variant={selected ? "tinted" : "bordered"} tone={selected ? "accent" : "neutral"} size="small" aria-pressed={selected} disabled={!canManage} onClick={() => set("welcomeChannelOrder", toggleInList(form.welcomeChannelOrder, option.value))}>
                    {selected ? `${position + 1}. ` : ""}
                    {option.label}
                  </CocoaButton>
                );
              })}
            </div>
          </CocoaField>
          <CocoaField label="Texto de consentimiento (RGPD)" hint={STATUS_LABELS.optional} fullWidth>
            <CocoaInput value={form.guestConsentText} onChange={(v) => set("guestConsentText", v)} multiline rows={3} maxLength={4000} disabled={!canManage} placeholder="Si se deja vacío, el portal usa el texto estándar." />
          </CocoaField>
          <CocoaField label="Aviso de uso de IA (AI Act art. 50)" hint={STATUS_LABELS.optional} fullWidth>
            <CocoaInput value={form.aiDisclosureText} onChange={(v) => set("aiDisclosureText", v)} multiline rows={3} maxLength={4000} disabled={!canManage} placeholder="Si se deja vacío, el portal usa el aviso estándar." />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      {/* Kioscos: lista, alta y emparejamiento (código de una sola vez). */}
      <CocoaSection title={`Kioscos (${number(kiosks.length)})`} meta={<span className="cocoa-note">Tablets de autoservicio del vestíbulo</span>}>
        {!canKiosk ? (
          <CocoaCallout tone="neutral" role="status" icon={<LockIcon size={16} aria-hidden="true" />}>
            Configurar kioscos requiere «kiosk.configure» (dirección o administración).
          </CocoaCallout>
        ) : (
          <div className="cocoa-stack" data-gap="3">
            {pairing ? (
              <CocoaCallout
                tone="accent"
                role="alert"
                title={`Código de emparejamiento de «${pairing.name}»`}
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPairing(null)}>
                    {ACTIONS.close}
                  </CocoaButton>
                }
              >
                Escribe <code>{pairing.code}</code> en la tablet antes de las {time(pairing.expiresAt)}. Se muestra una sola vez: si lo pierdes, vuelve a pulsar «Emparejar».
              </CocoaCallout>
            ) : null}
            {kiosksState.error ? (
              <CocoaState kind="error" inline title={STATUS_LABELS.loadError} message={kiosksState.error} onRetry={kiosksState.refresh} />
            ) : kiosksState.loading && !kiosksState.data ? (
              <CocoaSkeleton variant="row" lines={2} />
            ) : kiosks.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin kioscos" message="Da de alta la tablet del vestíbulo y empareja el dispositivo con el código." />
            ) : (
              <CocoaTable
                columns={kioskColumns}
                rows={kiosks}
                rowKey="id"
                caption="Kioscos de la propiedad"
                density="compact"
                rowActions={(row) => (
                  <CocoaButton variant="bordered" tone="neutral" size="small" disabled={kioskBusy !== null || row.status === "disabled"} loading={kioskBusy === row.id} onClick={() => void pairKiosk(row)} title={row.status === "disabled" ? "Kiosco desactivado" : "Genera un código de 8 dígitos válido unos minutos"}>
                    Emparejar
                  </CocoaButton>
                )}
                rowActionsVisible="always"
              />
            )}
            <CocoaFormSection title="Nuevo kiosco" description="Nombre y periféricos conectados a la tablet.">
              <CocoaFormRow columns={2}>
                <CocoaField label="Nombre" error={kioskError ?? undefined} required>
                  <CocoaInput value={kioskForm.name} onChange={(v) => setKioskForm((prev) => ({ ...prev, name: v }))} placeholder="Tablet mostrador" maxLength={80} error={Boolean(kioskError)} size="small" />
                </CocoaField>
                <CocoaField label="Lector MRZ" inline>
                  <CocoaSwitch checked={kioskForm.mrzReader} onChange={(v) => setKioskForm((prev) => ({ ...prev, mrzReader: v }))} size="small" />
                </CocoaField>
                <CocoaField label="Codificador de tarjetas" inline>
                  <CocoaSwitch checked={kioskForm.cardEncoder} onChange={(v) => setKioskForm((prev) => ({ ...prev, cardEncoder: v }))} size="small" />
                </CocoaField>
                <CocoaField label="TPV" inline>
                  <CocoaSwitch checked={kioskForm.paymentTerminal} onChange={(v) => setKioskForm((prev) => ({ ...prev, paymentTerminal: v }))} size="small" />
                </CocoaField>
                <CocoaField label="Impresora" inline>
                  <CocoaSwitch checked={kioskForm.printer} onChange={(v) => setKioskForm((prev) => ({ ...prev, printer: v }))} size="small" />
                </CocoaField>
              </CocoaFormRow>
              <div className="cocoa-row" data-gap="2" data-justify="end">
                <CocoaButton variant="filled" tone="accent" size="small" disabled={kioskBusy !== null} loading={kioskBusy === "create"} onClick={() => void createKiosk()}>
                  Crear kiosco
                </CocoaButton>
              </div>
            </CocoaFormSection>
          </div>
        )}
      </CocoaSection>

      <CocoaActionBar
        aria-label="Acciones de la política de check-in"
        status={!canManage ? "Solo lectura" : dirty ? "Cambios sin guardar" : savedAt ? `${STATUS_LABELS.saved} a las ${time(savedAt)}` : policyState.data?.updatedAt ? `Última modificación ${dateTime(policyState.data.updatedAt)}` : "Política por defecto (sin guardar todavía)"}
        primary={{ label: saving ? STATUS_LABELS.saving : ACTIONS.saveChanges, onClick: () => void save(), disabled: !canManage || !dirty || saving }}
        secondary={{ label: ACTIONS.revert, onClick: reset, disabled: !dirty || saving }}
        publishToastOffset
      />
    </CocoaPage>
  );
}

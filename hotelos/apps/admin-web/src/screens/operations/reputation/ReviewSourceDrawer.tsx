// Fuente de reseñas (Tanda T8 · lote T8-G · Cocoa 22): alta y edición de una
// ReviewSource en un CocoaDrawer, con el estado HONESTO que devuelve la API
// tras guardar (el colector decide: `unavailable` para Booking/Expedia sin
// partner, `pending` para Google sin OAuth, `connected` para CSV/correo/demo).
//
//   POST   /reputation/properties/:propertyId/sources        (SourceCreateSchema)
//   PATCH  /reputation/properties/:propertyId/sources/:id    (SourceUpdateSchema)
//   POST   /reputation/properties/:propertyId/sources/:id/sync
//   DELETE /reputation/properties/:propertyId/sources/:id    (baja lógica)
//
// Nunca se piden ni se envían credenciales: la autorización de un portal es
// su flujo OAuth (la API rechaza claves en la configuración con 400). Sin
// estilos en línea, sin colores literales, sin inputs crudos.

import { useEffect, useState } from "react";
import { useToast } from "../../../components/Toast";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDialog, CocoaDrawer, CocoaField, CocoaFormRow, CocoaInput, CocoaSelect, CocoaSwitch } from "../../../components/cocoa";
import { dateTime } from "../../../lib/format";
import { RETENTION_DAYS_DEFAULT, RETENTION_DAYS_GOOGLE, SOURCE_WEIGHT_DEFAULT, providerScaleMax, type ReviewProvider, type ReviewSourceMode } from "../../../services/reputation-contracts";
import { createReviewSource, disableReviewSource, reputationErrorMessage, syncReviewSource, updateReviewSource, type ReviewSourceDto } from "../../../services/reputationApi";
import {
  capabilityLabels,
  defaultModeFor,
  defaultSourceName,
  parseRetentionDays,
  parseWeight,
  providerOptions,
  sourceModeOptions,
  sourceStateCopy,
  sourceStateTone
} from "./reputation-helpers";

export type ReviewSourceDrawerProps = {
  open: boolean;
  /** Fuente a editar; `null` para crear una nueva. */
  source: ReviewSourceDto | null;
  onClose: () => void;
  /** Tras crear, editar, sincronizar o desactivar (la pantalla refresca). */
  onSaved: (source: ReviewSourceDto) => void;
};

const PROVIDER_OPTIONS = providerOptions();
const MODE_OPTIONS = sourceModeOptions();

function isProvider(value: string): value is ReviewProvider {
  return PROVIDER_OPTIONS.some((option) => option.value === value);
}

function isMode(value: string): value is ReviewSourceMode {
  return MODE_OPTIONS.some((option) => option.value === value);
}

export function ReviewSourceDrawer({ open, source, onClose, onSaved }: ReviewSourceDrawerProps) {
  const { showToast } = useToast();
  const [provider, setProvider] = useState<ReviewProvider>("csv");
  const [mode, setMode] = useState<ReviewSourceMode>("csv");
  const [displayName, setDisplayName] = useState("");
  const [weightText, setWeightText] = useState(String(SOURCE_WEIGHT_DEFAULT));
  const [retentionText, setRetentionText] = useState(String(RETENTION_DAYS_DEFAULT));
  const [externalLocationId, setExternalLocationId] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [isDemo, setIsDemo] = useState(false);
  const [saved, setSaved] = useState<ReviewSourceDto | null>(null);
  const [busy, setBusy] = useState<"save" | "sync" | "disable" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(null);
    setConfirmDisable(false);
    setSaved(source);
    if (source) {
      setProvider(isProvider(source.provider) ? source.provider : "csv");
      setMode(source.mode);
      setDisplayName(source.displayName);
      setWeightText(String(source.weight).replace(".", ","));
      setRetentionText(String(source.retentionDays));
      setExternalLocationId(source.externalLocationId ?? "");
      setExternalAccountId(source.externalAccountId ?? "");
      setIsDemo(source.isDemo);
    } else {
      setProvider("csv");
      setMode("csv");
      setDisplayName("");
      setWeightText(String(SOURCE_WEIGHT_DEFAULT));
      setRetentionText(String(RETENTION_DAYS_DEFAULT));
      setExternalLocationId("");
      setExternalAccountId("");
      setIsDemo(false);
    }
  }, [open, source]);

  const editing = saved !== null;
  const weight = parseWeight(weightText);
  const retentionDays = parseRetentionDays(retentionText);
  const weightError = weight === null ? "El peso debe estar entre 0,1 y 2." : null;
  const retentionError = retentionDays === null ? "La retención debe ser un entero entre 1 y 3650 días." : null;
  const googleRetentionNote = provider === "google" && retentionDays !== null && retentionDays > RETENTION_DAYS_GOOGLE ? `Google limita la caché de reseñas a ${RETENTION_DAYS_GOOGLE} días: la API recortará la retención.` : null;
  const scale = providerScaleMax(provider);

  const changeProvider = (value: string) => {
    if (!isProvider(value)) return;
    setProvider(value);
    const nextMode = defaultModeFor(value);
    setMode(nextMode);
    if (!displayName.trim() || displayName === defaultSourceName(provider, mode)) setDisplayName(defaultSourceName(value, nextMode));
    if (value === "google") setRetentionText(String(RETENTION_DAYS_GOOGLE));
  };

  const save = async () => {
    setError(null);
    if (weightError || retentionError) {
      setError(weightError ?? retentionError);
      return;
    }
    setBusy("save");
    try {
      const name = displayName.trim() || defaultSourceName(provider, mode);
      const result = saved
        ? await updateReviewSource(saved.id, {
            mode,
            displayName: name,
            weight: weight ?? SOURCE_WEIGHT_DEFAULT,
            retentionDays: retentionDays ?? RETENTION_DAYS_DEFAULT,
            externalLocationId: externalLocationId.trim() || null,
            externalAccountId: externalAccountId.trim() || null,
            ...(saved.status === "disabled" ? { enabled: true } : {})
          })
        : await createReviewSource({
            provider,
            mode,
            displayName: name,
            weight: weight ?? SOURCE_WEIGHT_DEFAULT,
            retentionDays: retentionDays ?? RETENTION_DAYS_DEFAULT,
            ...(externalLocationId.trim() ? { externalLocationId: externalLocationId.trim() } : {}),
            ...(externalAccountId.trim() ? { externalAccountId: externalAccountId.trim() } : {}),
            ...(isDemo ? { isDemo: true } : {})
          });
      setSaved(result);
      showToast(saved ? "Fuente actualizada." : "Fuente creada.", { variant: "success" });
      onSaved(result);
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo guardar la fuente."));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!saved) return;
    setError(null);
    setBusy("sync");
    try {
      const result = await syncReviewSource(saved.id);
      const run = result.run;
      const next: ReviewSourceDto = { ...saved, status: run.status === "failed" ? "error" : saved.status, lastRunAt: run.finishedAt, lastError: run.error ?? null, runs: [run, ...saved.runs].slice(0, 20) };
      setSaved(next);
      showToast(run.status === "failed" ? `La sincronización falló: ${run.error ?? "sin detalle"}` : `Sincronizada: ${run.fetched} leídas · ${run.created} nuevas · ${run.updated} actualizadas.`, { variant: run.status === "failed" ? "error" : "success" });
      onSaved(next);
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo sincronizar la fuente."));
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    if (!saved) return;
    setError(null);
    setBusy("disable");
    try {
      const result = await disableReviewSource(saved.id);
      setSaved(result);
      showToast("Fuente desactivada: deja de sincronizarse y de pesar en el índice.", { variant: "info" });
      onSaved(result);
      setConfirmDisable(false);
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo desactivar la fuente."));
    } finally {
      setBusy(null);
    }
  };

  const status = saved ? sourceStateCopy(saved.status, saved.lastError, saved.lastRunAt) : null;
  const capabilities = capabilityLabels(saved?.capabilities);

  return (
    <>
      <CocoaDrawer
        open={open}
        onClose={onClose}
        title={editing ? `Fuente · ${saved?.displayName ?? ""}` : "Nueva fuente de reseñas"}
        subtitle={editing ? "Cambia el modo, el peso o la retención; el estado lo decide la conexión real." : "Los portales con API oficial exigen autorización del propietario del perfil; sin credenciales, importa un CSV o conecta el correo de notificaciones."}
        size="md"
        footer={
          <div className="cocoa-row" data-gap="2" data-justify="between">
            <span className="cocoa-cluster">
              {editing && saved?.status !== "disabled" ? (
                <>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={sync} loading={busy === "sync"} disabled={busy !== null || saved?.status === "unavailable"} title={saved?.status === "unavailable" ? "El portal no ofrece acceso oficial: importa un CSV." : undefined}>
                    Sincronizar ahora
                  </CocoaButton>
                  <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => setConfirmDisable(true)} disabled={busy !== null}>
                    Desactivar
                  </CocoaButton>
                </>
              ) : null}
            </span>
            <span className="cocoa-cluster">
              <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy !== null}>
                Cerrar
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" onClick={save} loading={busy === "save"} disabled={busy !== null}>
                {editing ? (saved?.status === "disabled" ? "Guardar y reactivar" : "Guardar cambios") : "Crear fuente"}
              </CocoaButton>
            </span>
          </div>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {error ? (
            <CocoaCallout tone="danger" role="alert">
              {error}
            </CocoaCallout>
          ) : null}

          {saved && status ? (
            <CocoaCallout tone={sourceStateTone(saved.status) === "neutral" ? "neutral" : sourceStateTone(saved.status)} role="status" title="Estado de la conexión">
              <div className="cocoa-stack" data-gap="2">
                <span>{status}</span>
                <span className="cocoa-cluster">
                  {capabilities.length > 0 ? (
                    capabilities.map((label) => (
                      <CocoaBadge key={label} tone="neutral" variant="outline" size="small" uppercase={false}>
                        {label}
                      </CocoaBadge>
                    ))
                  ) : (
                    <CocoaBadge tone="neutral" variant="outline" size="small" uppercase={false}>
                      Sin capacidades declaradas
                    </CocoaBadge>
                  )}
                  {saved.hasCredentials ? (
                    <CocoaBadge tone="success" variant="dot" size="small" uppercase={false}>
                      Autorizada
                    </CocoaBadge>
                  ) : null}
                  {saved.isDemo ? (
                    <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false}>
                      Datos ficticios
                    </CocoaBadge>
                  ) : null}
                </span>
                {saved.lastSuccessAt ? <span className="cocoa-note">Última lectura correcta: {dateTime(saved.lastSuccessAt)}</span> : null}
              </div>
            </CocoaCallout>
          ) : null}

          <CocoaFormRow columns={2}>
            <CocoaField label="Portal" required help={scale ? `Publica notas sobre ${scale}.` : "La escala viaja en cada fila importada."}>
              <CocoaSelect value={provider} onChange={changeProvider} options={PROVIDER_OPTIONS} disabled={editing} aria-label="Portal de la fuente" />
            </CocoaField>
            <CocoaField label="Modo" required>
              <CocoaSelect value={mode} onChange={(value) => (isMode(value) ? setMode(value) : undefined)} options={MODE_OPTIONS} aria-label="Modo de la fuente" />
            </CocoaField>
          </CocoaFormRow>

          <CocoaField label="Nombre" help="Como se verá en la tabla de fuentes y en la bandeja.">
            <CocoaInput value={displayName} onChange={setDisplayName} maxLength={120} placeholder={defaultSourceName(provider, mode)} />
          </CocoaField>

          <CocoaFormRow columns={2}>
            <CocoaField label="Peso en el índice" required error={weightText.trim() ? (weightError ?? undefined) : undefined} help="0,1-2 (1 por defecto); ningún portal pesa más del 60 %.">
              <CocoaInput value={weightText} onChange={setWeightText} inputMode="decimal" maxLength={5} />
            </CocoaField>
            <CocoaField label="Retención del texto (días)" required error={retentionText.trim() ? (retentionError ?? undefined) : undefined} help={googleRetentionNote ?? "Pasado el plazo se purga el cuerpo; la nota y las categorías se conservan."}>
              <CocoaInput value={retentionText} onChange={setRetentionText} inputMode="numeric" maxLength={4} />
            </CocoaField>
          </CocoaFormRow>

          <CocoaFormRow columns={2}>
            <CocoaField label="Ubicación en el portal" help="Id del perfil o del establecimiento en el portal (opcional).">
              <CocoaInput value={externalLocationId} onChange={setExternalLocationId} maxLength={200} placeholder="locations/…" />
            </CocoaField>
            <CocoaField label="Cuenta en el portal" help="Opcional.">
              <CocoaInput value={externalAccountId} onChange={setExternalAccountId} maxLength={200} />
            </CocoaField>
          </CocoaFormRow>

          {!editing ? (
            <CocoaField label="Fuente de demostración" inline help="Reseñas ficticias con proveedor «<portal>_demo»; nunca datos reales.">
              <CocoaSwitch checked={isDemo} onChange={setIsDemo} size="small" aria-label="Fuente de demostración" />
            </CocoaField>
          ) : null}

          <CocoaCallout tone="neutral" role="note" title="Credenciales">
            Aquí no se guardan claves ni tokens. Google se autoriza con OAuth del propietario del perfil; Booking y Expedia solo a través de un partner certificado; Tripadvisor y HolidayCheck por correo de notificación.
          </CocoaCallout>
        </div>
      </CocoaDrawer>

      <CocoaDialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title="Desactivar la fuente"
        description="La fuente deja de sincronizarse y de contar en el índice; sus reseñas se conservan. Podrás reactivarla más tarde."
        tone="destructive"
        confirmLabel="Desactivar"
        onConfirm={disable}
        busy={busy === "disable"}
      />
    </>
  );
}

export default ReviewSourceDrawer;

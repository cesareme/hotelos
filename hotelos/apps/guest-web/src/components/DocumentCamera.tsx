import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { MAX_DOCUMENT_BYTES, dataUrlByteSize, formatDocumentHint, looksLikeMrz, normalizeMrzText, t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";

// Tanda CHK · W4-C (diseño §4a paso 3): captura del documento de identidad.
//   · `<input type="file" accept="image/*" capture="environment">` (cámara
//     trasera del móvil; en escritorio abre el selector);
//   · `getUserMedia` opcional con guía de encuadre de la MRZ (recuadro en el
//     tercio inferior); si el navegador no lo permite, solo queda el input;
//   · la imagen se reduce en un canvas (lado mayor ≤ 1600 px, JPEG 0,85) para
//     no superar CHECKIN_DOCUMENT_MAX_BYTES (6 MiB), se entrega como data: URL
//     y se DESCARTA en cliente en cuanto `onImage` resuelve (§7.3);
//   · «Pegar MRZ»: lector hardware o teclado → `onMrz(lines)`.
//
// Tanda L7 · L7-05 (WCAG 2.2 · 2.1.1 Keyboard, 4.1.3 Status Messages): el
// selector de archivo se abre desde un <button> real (el input de fichero queda
// fuera del orden de tabulación y oculto para el lector), el vídeo en directo es
// decorativo (`aria-hidden`), el desplegable de la MRZ enlaza su panel con
// `aria-controls` y la textarea lleva etiqueta; los errores y el estado
// «leyendo…» se anuncian en regiones vivas.

const MAX_SIDE_PX = 1600;
const JPEG_QUALITY = 0.85;

export type DocumentCameraProps = {
  lang: Lang;
  documentType: string | null;
  busy: boolean;
  /** Recibe la data: URL; debe resolver cuando el servidor haya contestado (la imagen se suelta entonces). */
  onImage: (dataUrl: string) => Promise<void>;
  onMrz: (lines: string[]) => Promise<void>;
  /** true tras un 400 DOCUMENT_UNREADABLE: abre el campo de la MRZ. */
  showMrzFallback?: boolean;
};

async function fileToDataUrl(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(file);
  });
  return downscale(original);
}

/** Reduce la imagen en un canvas; si el navegador no puede decodificarla devuelve la original. */
async function downscale(dataUrl: string): Promise<string> {
  if (typeof document === "undefined") return dataUrl;
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode_failed"));
      element.src = dataUrl;
    });
    const scale = Math.min(1, MAX_SIDE_PX / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale === 1 && dataUrlByteSize(dataUrl) <= MAX_DOCUMENT_BYTES) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch {
    return dataUrl;
  }
}

export function DocumentCamera({ lang, documentType, busy, onImage, onMrz, showMrzFallback = false }: DocumentCameraProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [mrzText, setMrzText] = useState("");
  const [mrzOpen, setMrzOpen] = useState(showMrzFallback);
  const canUseCamera = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const id = useId();
  const hintId = `${id}-hint`;
  const mrzPanelId = `${id}-mrz`;
  const mrzInputId = `${id}-mrz-input`;

  useEffect(() => {
    if (showMrzFallback) setMrzOpen(true);
  }, [showMrzFallback]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOpen(false);
  }

  // Release the camera when the component unmounts.
  useEffect(() => () => stopCamera(), []);

  async function send(dataUrl: string) {
    setLocalError(null);
    if (dataUrlByteSize(dataUrl) > MAX_DOCUMENT_BYTES) {
      setLocalError(t(lang, "imageTooLarge"));
      return;
    }
    try {
      await onImage(dataUrl);
    } finally {
      // Discard the client copy: nothing of the image survives the request.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await send(dataUrl);
    } catch {
      setLocalError(t(lang, "documentUnreadable"));
    }
  }

  async function openCamera() {
    setLocalError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      setCameraOpen(true);
      // The <video> mounts on the next render.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      });
    } catch {
      setLocalError(t(lang, "cameraUnavailable"));
    }
  }

  async function captureFrame() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0);
    const dataUrl = await downscale(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    stopCamera();
    await send(dataUrl);
  }

  async function submitMrz() {
    const lines = normalizeMrzText(mrzText);
    if (!looksLikeMrz(lines)) {
      setLocalError(t(lang, "documentUnreadable"));
      return;
    }
    setLocalError(null);
    await onMrz(lines);
    setMrzText("");
  }

  return (
    <div className="gp-camera" aria-busy={busy}>
      <p className="gp-camera-hint" id={hintId}>{formatDocumentHint(documentType, lang)}</p>

      {cameraOpen ? (
        <div className="gp-camera-live" role="group" aria-label={t(lang, "useCamera")}>
          <video ref={videoRef} className="gp-camera-video" playsInline muted autoPlay aria-hidden />
          <div className="gp-camera-guide" aria-hidden>
            <span className="gp-camera-guide-mrz" />
          </div>
          <div className="gp-stacked">
            <button type="button" className="gp-button gp-button-primary" onClick={() => void captureFrame()} disabled={busy}>
              {busy ? t(lang, "processing") : t(lang, "capture")}
            </button>
            <button type="button" className="gp-button gp-button-ghost" onClick={stopCamera} disabled={busy}>
              {t(lang, "cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="gp-camera-actions">
          {/* El input de fichero no se tabula ni se lee: lo abre el botón (teclado, puntero y lector). */}
          <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="gp-visually-hidden" tabIndex={-1} aria-hidden onChange={(event) => void onFile(event)} disabled={busy} />
          <button type="button" className="gp-button gp-button-primary" onClick={() => fileInputRef.current?.click()} disabled={busy} aria-describedby={hintId}>
            {busy ? t(lang, "processing") : t(lang, "takePhoto")}
          </button>
          {canUseCamera ? (
            <button type="button" className="gp-button gp-button-ghost" onClick={() => void openCamera()} disabled={busy}>
              {t(lang, "useCamera")}
            </button>
          ) : null}
        </div>
      )}

      <p className="gp-visually-hidden" role="status">{busy ? t(lang, "processing") : ""}</p>
      <div aria-live="polite">{localError ? <p className="gp-error" role="alert">{localError}</p> : null}</div>

      <div className="gp-mrz">
        <button type="button" className="gp-link" onClick={() => setMrzOpen((open) => !open)} aria-expanded={mrzOpen} aria-controls={mrzPanelId}>
          {t(lang, "pasteMrz")}
        </button>
        <div className="gp-stacked" id={mrzPanelId} hidden={!mrzOpen}>
          <label htmlFor={mrzInputId} className="gp-visually-hidden">
            {t(lang, "sendMrz")}
          </label>
          <textarea id={mrzInputId} className="gp-mrz-input" rows={3} value={mrzText} onChange={(event) => setMrzText(event.target.value)} placeholder={t(lang, "mrzPlaceholder")} spellCheck={false} autoCapitalize="characters" disabled={busy} />
          <button type="button" className="gp-button gp-button-ghost" onClick={() => void submitMrz()} disabled={busy || mrzText.trim() === ""}>
            {t(lang, "sendMrz")}
          </button>
        </div>
      </div>
    </div>
  );
}

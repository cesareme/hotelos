// SignaturePad — firma manuscrita en un lienzo (Tanda CHK · lote W4-A,
// docs/design/CHECKIN-AUTOMATIZADO-IA.md §4 «firma» y §8 «Drawer de check-in»).
//
// Un <canvas> con pointer events (ratón, dedo o lápiz; sin presión) que recoge
// trazos `{ t, x, y }` en coordenadas del bitmap, dos acciones «Borrar» /
// «Aceptar» (CocoaButton `large`: 32 px con ratón y ≥ 44 px con puntero
// grueso, WCAG 2.5.8) y una salida lista para POST …/check-in/signature:
//   { pngBase64, svg, strokeMeta: { points, durationMs, bbox } }
// El PNG es la evidencia (tinta negra sobre papel blanco, independiente del
// tema: el parte se imprime); el SVG es el trazo vectorial en `currentColor`;
// strokeMeta acompaña la fila `signatures` (el API exige ≥ 8 puntos).
//
// Lógica pura exportada para `node --test` (__tests__/signature-pad.test.mts):
// serializeStrokes · strokeMetaOf · svgOf · hasEnoughPoints · signatureOutputOf
// · pngBase64Of · canvasPointOf (geometría del control). Sin `style=`: el
// lienzo viste `.c22-control` (borde, fondo y color de tinta del sistema) y
// el resto son utilidades `cocoa-stack` / `cocoa-row` / `cocoa-note`.
//
// A11y: el lienzo es focusable (`tabIndex 0`) con `aria-label` y una nota
// `aria-describedby` que dice cómo firmar y el número de puntos (role=status);
// teclado: Retroceso o Supr borran, Intro acepta cuando hay trazo suficiente.
// En pantallas táctiles un `touchmove` no pasivo evita que el cajón haga scroll
// mientras se firma (no hay `touch-action` sin hoja de estilos propia).

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";

// =============================================================== tipos

export type StrokePoint = { t: number; x: number; y: number };
export type SignatureStroke = StrokePoint[];
export type SignatureBBox = { x: number; y: number; width: number; height: number };
export type SignatureStrokeMeta = { points: number; durationMs: number; bbox: SignatureBBox };
export type SignatureSize = { width: number; height: number };
export type SignatureOutput = { pngBase64: string; svg: string; strokeMeta: SignatureStrokeMeta };

/** Mínimo de puntos que acepta el API (signature.service.ts SIGNATURE_MIN_POINTS). */
export const SIGNATURE_MIN_POINTS = 8;
export const SIGNATURE_PAD_WIDTH = 480;
export const SIGNATURE_PAD_HEIGHT = 160;
export const SIGNATURE_STROKE_WIDTH = 2;
export const SIGNATURE_TOO_SHORT_MESSAGE = `La firma es demasiado corta: se necesitan al menos ${SIGNATURE_MIN_POINTS} puntos.`;

// =============================================================== lógica pura

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Puntos totales de la firma (todos los trazos). */
export function countPoints(strokes: readonly (readonly StrokePoint[])[]): number {
  return strokes.reduce((total, stroke) => total + stroke.length, 0);
}

/** ≥ 8 puntos en total (el API rechaza menos). */
export function hasEnoughPoints(strokes: readonly (readonly StrokePoint[])[]): boolean {
  return countPoints(strokes) >= SIGNATURE_MIN_POINTS;
}

/**
 * Trazos listos para transportar: sin trazos vacíos, coordenadas a 0,1 px y
 * `t` en milisegundos enteros relativos al primer punto de la firma (0).
 */
export function serializeStrokes(strokes: readonly (readonly StrokePoint[])[]): SignatureStroke[] {
  const kept = strokes.filter((stroke) => stroke.length > 0);
  const t0 = kept.length > 0 ? Math.min(...kept.map((stroke) => Math.min(...stroke.map((point) => point.t)))) : 0;
  return kept.map((stroke) => stroke.map((point) => ({ t: Math.max(0, Math.round(point.t - t0)), x: round1(point.x), y: round1(point.y) })));
}

/** Puntos, duración (último − primer `t`) y caja envolvente de los trazos; todo a 0 con una firma vacía. */
export function strokeMetaOf(strokes: readonly (readonly StrokePoint[])[]): SignatureStrokeMeta {
  const points = countPoints(strokes);
  if (points === 0) return { points: 0, durationMs: 0, bbox: { x: 0, y: 0, width: 0, height: 0 } };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minT = Infinity;
  let maxT = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
      if (point.t < minT) minT = point.t;
      if (point.t > maxT) maxT = point.t;
    }
  }
  return {
    points,
    durationMs: Math.max(0, Math.round(maxT - minT)),
    bbox: { x: round1(minX), y: round1(minY), width: round1(maxX - minX), height: round1(maxY - minY) }
  };
}

/** SVG del trazo (una <path> por trazo, `currentColor`, sin relleno). */
export function svgOf(strokes: readonly (readonly StrokePoint[])[], size: SignatureSize = { width: SIGNATURE_PAD_WIDTH, height: SIGNATURE_PAD_HEIGHT }): string {
  const paths = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const d = stroke.map((point, index) => `${index === 0 ? "M" : "L"}${round1(point.x)} ${round1(point.y)}`).join(" ");
      // Un solo punto: segmento nulo para que el redondeo de la línea lo pinte.
      const path = stroke.length === 1 ? `${d} L${round1(stroke[0]!.x)} ${round1(stroke[0]!.y)}` : d;
      return `<path d="${path}" fill="none" stroke="currentColor" stroke-width="${SIGNATURE_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" width="${size.width}" height="${size.height}">${paths}</svg>`;
}

/** base64 puro de un `data:image/png;base64,…` (o el texto tal cual si ya venía sin prefijo). */
export function pngBase64Of(dataUrl: string): string {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return dataUrl.trim();
  if (match[1]!.toLowerCase() !== "image/png") throw new Error(`La firma debe ser image/png (recibido ${match[1]}).`);
  return match[2]!;
}

/** Salida completa de una firma; lanza SIGNATURE_TOO_SHORT_MESSAGE con menos de 8 puntos. */
export function signatureOutputOf(strokes: readonly (readonly StrokePoint[])[], pngDataUrl: string, size: SignatureSize = { width: SIGNATURE_PAD_WIDTH, height: SIGNATURE_PAD_HEIGHT }): SignatureOutput {
  const serialized = serializeStrokes(strokes);
  if (!hasEnoughPoints(serialized)) throw new Error(SIGNATURE_TOO_SHORT_MESSAGE);
  return { pngBase64: pngBase64Of(pngDataUrl), svg: svgOf(serialized, size), strokeMeta: strokeMetaOf(serialized) };
}

/**
 * Punto del bitmap desde una posición de puntero (pura sobre las medidas): el
 * bitmap se estira en la caja de contenido, así que se descuentan borde y
 * padding del control y se escala por `bitmap / contenido`.
 */
export function canvasPointOf(
  box: { left: number; top: number; width: number; height: number; borderLeft: number; borderTop: number; borderRight: number; borderBottom: number; paddingLeft: number; paddingTop: number; paddingRight: number; paddingBottom: number },
  bitmap: SignatureSize,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const contentWidth = Math.max(1, box.width - box.borderLeft - box.borderRight - box.paddingLeft - box.paddingRight);
  const contentHeight = Math.max(1, box.height - box.borderTop - box.borderBottom - box.paddingTop - box.paddingBottom);
  const x = ((clientX - box.left - box.borderLeft - box.paddingLeft) * bitmap.width) / contentWidth;
  const y = ((clientY - box.top - box.borderTop - box.paddingTop) * bitmap.height) / contentHeight;
  return { x: Math.min(bitmap.width, Math.max(0, x)), y: Math.min(bitmap.height, Math.max(0, y)) };
}

/** Evidencia PNG: tinta negra sobre papel blanco (el parte se imprime; no depende del tema). */
export function renderSignaturePng(strokes: readonly (readonly StrokePoint[])[], size: SignatureSize): string {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("El navegador no admite el lienzo de firma.");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.strokeStyle = "black";
  ctx.lineWidth = SIGNATURE_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
    if (stroke.length === 1) ctx.lineTo(stroke[0]!.x, stroke[0]!.y);
    for (let index = 1; index < stroke.length; index += 1) ctx.lineTo(stroke[index]!.x, stroke[index]!.y);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

function pointFromEvent(canvas: HTMLCanvasElement, event: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const cs = getComputedStyle(canvas);
  const px = (value: string) => Number.parseFloat(value) || 0;
  return canvasPointOf(
    {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      borderLeft: px(cs.borderLeftWidth),
      borderTop: px(cs.borderTopWidth),
      borderRight: px(cs.borderRightWidth),
      borderBottom: px(cs.borderBottomWidth),
      paddingLeft: px(cs.paddingLeft),
      paddingTop: px(cs.paddingTop),
      paddingRight: px(cs.paddingRight),
      paddingBottom: px(cs.paddingBottom)
    },
    { width: canvas.width, height: canvas.height },
    event.clientX,
    event.clientY
  );
}

/** Texto de la nota bajo el lienzo (pura): cómo firmar y cuántos puntos faltan. */
export function signaturePadHint(points: number): string {
  if (points === 0) return `Firma con el dedo, el lápiz o el ratón. Retroceso borra; Intro acepta (mínimo ${SIGNATURE_MIN_POINTS} puntos).`;
  if (points < SIGNATURE_MIN_POINTS) return `${points} ${points === 1 ? "punto" : "puntos"} · faltan ${SIGNATURE_MIN_POINTS - points} para aceptar.`;
  return `${points} puntos · lista para aceptar.`;
}

// =============================================================== componente

export type SignaturePadProps = {
  /** Firma aceptada (≥ 8 puntos): PNG, SVG y metadatos del trazo. */
  onAccept: (output: SignatureOutput) => void;
  onClear?: () => void;
  disabled?: boolean;
  /** El envío está en curso: «Aceptar» muestra el spinner y el lienzo no admite trazo. */
  busy?: boolean;
  width?: number;
  height?: number;
  acceptLabel?: string;
  clearLabel?: string;
  "aria-label"?: string;
};

export function SignaturePad({ onAccept, onClear, disabled = false, busy = false, width = SIGNATURE_PAD_WIDTH, height = SIGNATURE_PAD_HEIGHT, acceptLabel = "Aceptar", clearLabel = "Borrar", "aria-label": ariaLabel = "Área de firma" }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<SignatureStroke[]>([]);
  const currentRef = useRef<SignatureStroke | null>(null);
  const [points, setPoints] = useState(0);
  const hintId = useId();
  const locked = disabled || busy;
  const enough = points >= SIGNATURE_MIN_POINTS;

  const contextOf = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (!canvas || !ctx) return null;
    // Tinta del sistema (`.c22-control` → color: var(--cocoa-label)); nunca un literal.
    ctx.strokeStyle = getComputedStyle(canvas).color;
    ctx.lineWidth = SIGNATURE_STROKE_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    return ctx;
  }, []);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokesRef.current = [];
    currentRef.current = null;
    setPoints(0);
    onClear?.();
  }, [onClear]);

  const accept = useCallback(() => {
    if (locked || !hasEnoughPoints(strokesRef.current)) return;
    onAccept(signatureOutputOf(strokesRef.current, renderSignaturePng(strokesRef.current, { width, height }), { width, height }));
  }, [height, locked, onAccept, width]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (locked || event.button !== 0) return;
      const canvas = canvasRef.current;
      const ctx = contextOf();
      if (!canvas || !ctx) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      canvas.focus({ preventScroll: true });
      const point = pointFromEvent(canvas, event);
      currentRef.current = [{ t: event.timeStamp, ...point }];
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      setPoints(countPoints(strokesRef.current) + 1);
    },
    [contextOf, locked]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const stroke = currentRef.current;
      const canvas = canvasRef.current;
      if (!stroke || !canvas || locked) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const point = pointFromEvent(canvas, event);
      stroke.push({ t: event.timeStamp, ...point });
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      setPoints(countPoints(strokesRef.current) + stroke.length);
    },
    [locked]
  );

  const finishStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = currentRef.current;
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!stroke) return;
    currentRef.current = null;
    strokesRef.current = [...strokesRef.current, stroke];
    setPoints(countPoints(strokesRef.current));
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        clear();
      } else if (event.key === "Enter" && enough) {
        event.preventDefault();
        accept();
      }
    },
    [accept, clear, enough]
  );

  // El scroll del cajón no debe llevarse el trazo en pantallas táctiles.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const block = (event: TouchEvent) => {
      if (currentRef.current) event.preventDefault();
    };
    canvas.addEventListener("touchmove", block, { passive: false });
    return () => canvas.removeEventListener("touchmove", block);
  }, []);

  return (
    <div className="cocoa-stack" data-gap="2" data-cocoa="signature-pad">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="c22-control"
        data-multiline="true"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        aria-disabled={locked || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onKeyDown={onKeyDown}
      />
      <p id={hintId} className="cocoa-note" role="status">
        {signaturePadHint(points)}
      </p>
      <div className="cocoa-row" data-gap="2" data-justify="end">
        <CocoaButton variant="bordered" tone="neutral" size="large" onClick={clear} disabled={locked || points === 0}>
          {clearLabel}
        </CocoaButton>
        <CocoaButton variant="filled" tone="accent" size="large" onClick={accept} disabled={locked || !enough} loading={busy}>
          {acceptLabel}
        </CocoaButton>
      </div>
    </div>
  );
}

export default SignaturePad;

// Compresión en cliente de la captura móvil (Tanda T9 · lote T9-04,
// docs/design/DOCUMENTOS-DIGITALIZACION.md §4.1 «Foto desde el móvil»): a
// photo of an invoice taken with the PWA is scaled on a canvas to ≤ 1.600 px on
// its long side and re-encoded as JPEG at quality 0,82 before it travels as
// base64 in `POST …/documents`. The decision is pure (`planCompression`, tested
// under `node --test`); the canvas work (`compressImageFile`) only runs where
// `window` and `document` exist and hands the original file back on any
// failure, so a decode the browser cannot do (HEIC on some desktops) never
// blocks the capture. PDFs and XML e-invoices are never touched.
//
// `{ force: true }` (Tanda UX-3 · corrector REV-L01, fotos del parte): the
// canvas re-encode is ALSO the only step that drops the EXIF block (GPS,
// device model, timestamp) of a gallery picture, so a caller that stores the
// bytes for other people to download can force it: the `small_enough` skip is
// off and the canvas JPEG is returned even when it is not smaller.

export const CAPTURE_MAX_SIDE_PX = 1600;
export const CAPTURE_JPEG_QUALITY = 0.82;
/** Below this size an image that already fits the long side is sent as it is. */
export const CAPTURE_SKIP_BELOW_BYTES = 512 * 1024;

/** MIME types the canvas can decode and that gain from a JPEG re-encode. */
const COMPRESSIBLE = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/bmp", "image/heic", "image/heif", "image/tiff"]);

export type CompressionSkipReason = "not_image" | "no_dimensions" | "small_enough";

export type CompressionPlan = {
  /** true when the file travels unchanged. */
  skip: boolean;
  reason: CompressionSkipReason | null;
  targetWidth: number;
  targetHeight: number;
  /** JPEG quality of the re-encode (0,82); kept for a skipped plan for symmetry. */
  quality: number;
  /** `image/jpeg` when re-encoding; null when skipped. */
  outputMimeType: "image/jpeg" | null;
};

export type CompressionInput = { width: number; height: number; sizeBytes: number; mimeType: string };

export type CompressionOptions = {
  /** Always re-encode a decodable image (no `small_enough` skip, canvas JPEG kept even if larger): strips EXIF metadata. */
  force?: boolean;
};

/** Pure plan: PDF / XML / unknown → skip; image within 1.600 px and under 512 KiB → skip (unless `force`); otherwise scale the long side to 1.600 px (aspect kept) at quality 0,82. */
export function planCompression({ width, height, sizeBytes, mimeType }: CompressionInput, options: CompressionOptions = {}): CompressionPlan {
  const mime = (mimeType ?? "").trim().toLowerCase();
  const skipped = (reason: CompressionSkipReason): CompressionPlan => ({ skip: true, reason, targetWidth: width, targetHeight: height, quality: CAPTURE_JPEG_QUALITY, outputMimeType: null });
  if (!COMPRESSIBLE.has(mime)) return skipped("not_image");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return skipped("no_dimensions");
  const longSide = Math.max(width, height);
  if (!options.force && longSide <= CAPTURE_MAX_SIDE_PX && sizeBytes <= CAPTURE_SKIP_BELOW_BYTES) return skipped("small_enough");
  const scale = Math.min(1, CAPTURE_MAX_SIDE_PX / longSide);
  return {
    skip: false,
    reason: null,
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale)),
    quality: CAPTURE_JPEG_QUALITY,
    outputMimeType: "image/jpeg"
  };
}

/** «foto.png» → «foto.jpg» · «IMG_0001.HEIC» → «IMG_0001.jpg» · «captura» → «captura.jpg» (pure). */
export function jpegFileName(name: string): string {
  const trimmed = name.trim() || "captura";
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base}.jpg`;
}

export type CompressResult = {
  /** The re-encoded JPEG, or the original file when the plan skipped or the canvas failed. */
  file: File;
  compressed: boolean;
  originalBytes: number;
  /** Pixel size of the decoded image; null when it could not be decoded (or outside a browser). */
  width: number | null;
  height: number | null;
  plan: CompressionPlan | null;
};

const untouched = (file: File, plan: CompressionPlan | null = null, width: number | null = null, height: number | null = null): CompressResult => ({ file, compressed: false, originalBytes: file.size, width, height, plan });

function decodeImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Scale and re-encode a captured image following `planCompression`; the
 * original file comes back untouched outside a browser, for a skipped plan, when
 * the image cannot be decoded, or when the JPEG would not be smaller (unless
 * `force`: the canvas JPEG is kept whatever its size, so the EXIF block never
 * travels). The browser applies the EXIF orientation while decoding
 * (`image-orientation: from-image`, default since 2020), so a phone photo lands
 * upright — also in the forced re-encode.
 */
export async function compressImageFile(file: File, options: CompressionOptions = {}): Promise<CompressResult> {
  if (typeof window === "undefined" || typeof document === "undefined") return untouched(file);
  const quick = planCompression({ width: 0, height: 0, sizeBytes: file.size, mimeType: file.type }, options);
  if (quick.reason === "not_image") return untouched(file, quick);
  const image = await decodeImage(file);
  if (!image) return untouched(file, quick);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const plan = planCompression({ width, height, sizeBytes: file.size, mimeType: file.type }, options);
  if (plan.skip) return untouched(file, plan, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = plan.targetWidth;
  canvas.height = plan.targetHeight;
  const context = canvas.getContext("2d");
  if (!context) return untouched(file, plan, width, height);
  context.drawImage(image, 0, 0, plan.targetWidth, plan.targetHeight);
  const blob = await toJpegBlob(canvas, plan.quality);
  if (!blob || blob.size === 0 || (!options.force && blob.size >= file.size)) return untouched(file, plan, width, height);
  const compressed = new File([blob], jpegFileName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  return { file: compressed, compressed: true, originalBytes: file.size, width, height, plan };
}

const CHUNK = 0x8000;

/** Base64 of a file or blob (no `data:` prefix), chunked so a 25 MB scan never overflows the call stack; works in the browser and under Node. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(binary);
}

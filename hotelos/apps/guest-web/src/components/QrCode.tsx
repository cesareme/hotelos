import { useMemo } from "react";
import { encodeQr } from "../checkin/qr-encoder";

// Tanda CHK · corrector REV3-14: QR escaneable como SVG inline (sin dependencias)
// a partir del codificador puro copiado del QR VeriFactu (checkin/qr-encoder.ts).
// `label` es el texto accesible; el payload no se pinta como texto.

export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const matrix = useMemo(() => {
    try {
      return encodeQr(value, "M");
    } catch {
      return null;
    }
  }, [value]);
  if (!matrix) return <code className="gp-qr-payload">{value}</code>;
  const quiet = 4;
  const modules = matrix.size + quiet * 2;
  const rects: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.modules[row]![col]) rects.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }
  return (
    <svg className="gp-qr-svg" viewBox={`0 0 ${modules} ${modules}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={rects.join("")} fill="#000000" />
    </svg>
  );
}

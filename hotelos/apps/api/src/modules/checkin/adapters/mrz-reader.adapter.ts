// Lector de MRZ del kiosco (Tanda CHK · lote W3-C; diseño §2.2 «lectores
// hardware»: Regula, 3M CR100, Access-IS emiten la MRZ como texto por keyboard
// wedge o SDK y entra directamente en el parser sin IA).
//
// Contrato + dos implementaciones sin proveedor:
//   · noneMrzReader — kind "none": read() devuelve null siempre. Sin lector el
//     kiosco ofrece cámara (identity-capture.service.ts) o formulario manual;
//     nunca inventa líneas.
//   · bufferedMrzReader(kind) — cola en memoria para "keyboard_wedge" (el lector
//     «teclea» las 2-3 líneas y un salto) o "sdk" (el SDK entrega el texto):
//     push(text) normaliza el texto a líneas MRZ y lo encola como un bloque;
//     read() devuelve el siguiente bloque o null si no hay nada pendiente. El
//     kiosco pasa las líneas a parseMrz (@hotelos/compliance), que valida
//     formato y dígitos de control: aquí no se interpreta nada.
//
// Normalización (normalizeMrzText): saltos CRLF/CR/LF, mayúsculas, sin espacios
// ni tabuladores dentro de la línea (los wedges los insertan al final), líneas
// vacías fuera. No se recortan ni «corrigen» caracteres: una línea corrupta
// llega tal cual y parseMrz la rechaza con su motivo.

export type MrzReaderKind = "none" | "keyboard_wedge" | "sdk";

export type MrzReader = {
  kind: MrzReaderKind;
  /** Siguiente lectura disponible como líneas MRZ, o null si no hay ninguna. */
  read(): Promise<string[] | null>;
};

export type BufferedMrzReader = MrzReader & {
  kind: Exclude<MrzReaderKind, "none">;
  /** Recibe el texto que emite el lector; devuelve las líneas encoladas (0 si el texto estaba vacío). */
  push(text: string): number;
  /** Bloques pendientes de leer. */
  pending(): number;
  /** Vacía la cola (cambio de huésped en el kiosco). */
  clear(): void;
};

/** Texto de un lector → líneas MRZ (mayúsculas, sin blancos, sin líneas vacías). */
export function normalizeMrzText(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[\s ]+/g, "").toUpperCase())
    .filter((line) => line.length > 0);
}

/** Sin lector: nunca hay lectura. */
export const noneMrzReader: MrzReader = Object.freeze({
  kind: "none" as const,
  read: async () => null
});

/** Lector por texto (keyboard wedge o SDK): cola FIFO de bloques normalizados. */
export function bufferedMrzReader(kind: Exclude<MrzReaderKind, "none"> = "keyboard_wedge"): BufferedMrzReader {
  const queue: string[][] = [];
  return {
    kind,
    push(text) {
      const lines = normalizeMrzText(text);
      if (lines.length === 0) return 0;
      queue.push(lines);
      return lines.length;
    },
    pending: () => queue.length,
    clear() {
      queue.length = 0;
    },
    read: async () => queue.shift() ?? null
  };
}

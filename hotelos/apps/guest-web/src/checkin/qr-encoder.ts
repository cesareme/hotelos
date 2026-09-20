// Codificador QR mínimo (ISO/IEC 18004, modo byte, versiones 1-20), copia
// literal y sin dependencias de apps/api/src/modules/invoicing/pdf/qr-encoder.ts
// (el del QR VeriFactu de las facturas; su test unitario lo coteja contra la
// implementación de referencia). Tanda CHK · corrector REV3-14: la pantalla de
// llegada (portal y kiosco) pinta la llave móvil como QR escaneable (SVG inline)
// en vez del payload `hotelos://unlock?…` como texto. Nivel de corrección M.
export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export type QrMatrix = {
  version: number;
  size: number;
  mask: number;
  ecLevel: QrErrorCorrectionLevel;
  /** modules[row][col] === true → dark. */
  modules: boolean[][];
};

// ── Tables (versions 1-20) ───────────────────────────────────────────────────

/** [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords] per version, per level. */
const EC_TABLE: Record<QrErrorCorrectionLevel, ReadonlyArray<readonly [number, number, number, number, number]>> = {
  L: [
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0], [24, 2, 92, 2, 93], [26, 4, 107, 0, 0], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99], [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108]
  ],
  M: [
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42]
  ],
  Q: [
    [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
    [28, 4, 22, 4, 23], [26, 4, 20, 6, 21], [24, 8, 20, 4, 21], [20, 11, 16, 5, 17], [30, 5, 24, 7, 25],
    [24, 15, 19, 2, 20], [28, 1, 22, 15, 23], [28, 17, 22, 1, 23], [26, 17, 21, 4, 22], [30, 15, 24, 5, 25]
  ],
  H: [
    [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
    [24, 3, 12, 8, 13], [28, 7, 14, 4, 15], [22, 12, 11, 4, 12], [24, 11, 12, 5, 13], [24, 11, 12, 7, 13],
    [30, 3, 15, 13, 16], [28, 2, 14, 17, 15], [28, 2, 14, 19, 15], [26, 9, 13, 16, 14], [28, 15, 15, 10, 16]
  ]
};

const ALIGNMENT_POSITIONS: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]
];

const EC_LEVEL_BITS: Record<QrErrorCorrectionLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 20;

// ── GF(256) arithmetic (primitive polynomial 0x11D) ──────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial coefficients (highest degree first) for `count` EC codewords. */
function generatorPolynomial(count: number): number[] {
  let poly = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: readonly number[], ecCount: number): number[] {
  const gen = generatorPolynomial(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    if (factor === 0) continue;
    for (let j = 0; j < ecCount; j++) remainder[j] ^= gfMul(gen[j + 1]!, factor);
  }
  return remainder;
}

// ── Bit buffer & data codewords ──────────────────────────────────────────────

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

function dataCapacityCodewords(version: number, level: QrErrorCorrectionLevel): number {
  const [, g1, d1, g2, d2] = EC_TABLE[level][version - 1]!;
  return g1 * d1 + g2 * d2;
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteLength: number, level: QrErrorCorrectionLevel): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= dataCapacityCodewords(version, level) * 8) return version;
  }
  throw new Error(`QR: el contenido (${byteLength} bytes) supera la capacidad de la versión ${MAX_VERSION} con nivel ${level}.`);
}

function buildDataCodewords(bytes: Uint8Array, version: number, level: QrErrorCorrectionLevel): number[] {
  const capacity = dataCapacityCodewords(version, level);
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4);
  buffer.put(bytes.length, charCountBits(version));
  for (const byte of bytes) buffer.put(byte, 8);
  const terminator = Math.min(4, capacity * 8 - buffer.length);
  buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | buffer.bits[i + j]!;
    codewords.push(value);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < capacity; i++) codewords.push(pads[i % 2]!);
  return codewords;
}

/** Data + EC blocks interleaved as the standard places them. */
function buildFinalCodewords(data: readonly number[], version: number, level: QrErrorCorrectionLevel): number[] {
  const [ecPerBlock, g1, d1, g2, d2] = EC_TABLE[level][version - 1]!;
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let offset = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const size = i < g1 ? d1 : d2;
    const chunk = data.slice(offset, offset + size);
    offset += size;
    blocks.push({ data: chunk, ec: reedSolomon(chunk, ecPerBlock) });
  }
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]!);
  for (let i = 0; i < ecPerBlock; i++) for (const block of blocks) out.push(block.ec[i]!);
  return out;
}

// ── Matrix ───────────────────────────────────────────────────────────────────

type Cell = boolean | null;

function setFinder(grid: Cell[][], reserved: boolean[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= grid.length || cc >= grid.length) continue;
      const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && ((r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      grid[rr]![cc] = dark;
      reserved[rr]![cc] = true;
    }
  }
}

function setAlignment(grid: Cell[][], reserved: boolean[][], row: number, col: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      grid[row + r]![col + c] = dark;
      reserved[row + r]![col + c] = true;
    }
  }
}

/**
 * Remainder of (value · x^degree) divided by `generator` over GF(2), where
 * `generator` has exactly `degree` as its highest power and `value` has
 * `dataBits` bits (BCH systematic encoding of the format / version fields).
 */
function bchRemainder(value: number, dataBits: number, generator: number, degree: number): number {
  let remainder = value << degree;
  for (let bit = dataBits + degree - 1; bit >= degree; bit--) {
    if (remainder & (1 << bit)) remainder ^= generator << (bit - degree);
  }
  return remainder & ((1 << degree) - 1);
}

/** 15-bit format information (BCH 15,5 with generator 0x537, masked with 0x5412). */
export function formatInformationBits(level: QrErrorCorrectionLevel, mask: number): number {
  const data = (EC_LEVEL_BITS[level] << 3) | mask;
  const remainder = bchRemainder(data, 5, 0x537, 10);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** 18-bit version information (BCH 18,6 with generator 0x1f25), versions ≥ 7. */
export function versionInformationBits(version: number): number {
  const remainder = bchRemainder(version, 6, 0x1f25, 12);
  return (version << 12) | remainder;
}

function placeFormatInfo(grid: Cell[][], level: QrErrorCorrectionLevel, mask: number): void {
  const size = grid.length;
  const bits = formatInformationBits(level, mask);
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1;
  // Around the top-left finder.
  for (let i = 0; i < 6; i++) grid[i]![8] = bit(i);
  grid[7]![8] = bit(6);
  grid[8]![8] = bit(7);
  grid[8]![7] = bit(8);
  for (let i = 9; i < 15; i++) grid[8]![14 - i] = bit(i);
  // Below the top-right finder and right of the bottom-left finder.
  for (let i = 0; i < 8; i++) grid[8]![size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) grid[size - 15 + i]![8] = bit(i);
  grid[size - 8]![8] = true; // dark module
}

function placeVersionInfo(grid: Cell[][], version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = versionInformationBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    grid[a]![b] = bit;
    grid[b]![a] = bit;
  }
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      throw new Error(`QR: máscara desconocida ${mask}`);
  }
}

function buildMatrix(codewords: readonly number[], version: number, level: QrErrorCorrectionLevel, mask: number): boolean[][] {
  const size = version * 4 + 17;
  const grid: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  setFinder(grid, reserved, 0, 0);
  setFinder(grid, reserved, 0, size - 7);
  setFinder(grid, reserved, size - 7, 0);
  const positions = ALIGNMENT_POSITIONS[version - 1]!;
  for (const row of positions) {
    for (const col of positions) {
      if (reserved[row]![col]) continue; // overlaps a finder pattern
      setAlignment(grid, reserved, row, col);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6]![i]) {
      grid[6]![i] = i % 2 === 0;
      reserved[6]![i] = true;
    }
    if (!reserved[i]![6]) {
      grid[i]![6] = i % 2 === 0;
      reserved[i]![6] = true;
    }
  }
  // Reserve format / version areas before data placement.
  for (let i = 0; i < 9; i++) {
    reserved[i]![8] = true;
    reserved[8]![i] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      reserved[a]![b] = true;
      reserved[b]![a] = true;
    }
  }

  // Zig-zag data placement, two columns at a time, skipping the timing column.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >> 3]!;
          dark = ((byte >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        if (maskBit(mask, row, col)) dark = !dark;
        grid[row]![col] = dark;
      }
    }
    upward = !upward;
  }

  placeFormatInfo(grid, level, mask);
  placeVersionInfo(grid, version);
  return grid.map((row) => row.map((cell) => cell === true));
}

/** Standard penalty score (ISO 18004 §7.8.3.1, N1=3 N2=3 N3=40 N4=10). */
export function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const runPenalty = (line: boolean[]): number => {
    let total = 0;
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
        continue;
      }
      if (run >= 5) total += 3 + (run - 5);
      run = 1;
    }
    return total;
  };
  for (let r = 0; r < size; r++) score += runPenalty(modules[r]!);
  for (let c = 0; c < size; c++) score += runPenalty(modules.map((row) => row[c]!));
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r]![c];
      if (v === modules[r]![c + 1] && v === modules[r + 1]![c] && v === modules[r + 1]![c + 1]) score += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  const hasPattern = (get: (i: number) => boolean | undefined, start: number): boolean => {
    for (let i = 0; i < 7; i++) if (get(start + i) !== pattern[i]) return false;
    const lightBefore = [1, 2, 3, 4].every((k) => get(start - k) === false);
    const lightAfter = [7, 8, 9, 10].every((k) => get(start + k) === false);
    return lightBefore || lightAfter;
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 7; c++) {
      if (hasPattern((i) => (i < 0 || i >= size ? undefined : modules[r]![i]), c)) score += 40;
      if (hasPattern((i) => (i < 0 || i >= size ? undefined : modules[i]![r]), c)) score += 40;
    }
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const ratio = Math.abs((dark * 100) / (size * size) - 50);
  score += Math.floor(ratio / 5) * 10;
  return score;
}

/** Encode `text` (UTF-8) with a fixed mask (tests / reference comparison). */
export function encodeQrWithMask(text: string, mask: number, level: QrErrorCorrectionLevel = "M", forcedVersion?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = forcedVersion ?? chooseVersion(bytes.length, level);
  if (version < 1 || version > MAX_VERSION) throw new Error(`QR: versión ${version} fuera del rango 1-${MAX_VERSION}.`);
  const data = buildDataCodewords(bytes, version, level);
  const codewords = buildFinalCodewords(data, version, level);
  return { version, size: version * 4 + 17, mask, ecLevel: level, modules: buildMatrix(codewords, version, level, mask) };
}

/** Encode `text` choosing the mask with the lowest penalty score. */
export function encodeQr(text: string, level: QrErrorCorrectionLevel = "M"): QrMatrix {
  let best: QrMatrix | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = encodeQrWithMask(text, mask, level);
    const score = penaltyScore(candidate.modules);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best!;
}

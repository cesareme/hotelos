// Parser de extractos bancarios españoles AEB Cuaderno 43 (Norma 43).
//
// Fichero de texto de registros de 80 columnas (posiciones 1-80 en la
// especificación; aquí índices 0-based en los `slice`). Registros:
//   11 cabecera de cuenta   entidad 3-6 · oficina 7-10 · cuenta 11-20 ·
//                           fecha inicial 21-26 · fecha final 27-32 ·
//                           clave saldo inicial 33 (1 debe · 2 haber) ·
//                           saldo inicial 34-47 · divisa 48-50 · modalidad 51 ·
//                           nombre abreviado 52-77
//   22 movimiento           oficina origen 7-10 · fecha operación 11-16 ·
//                           fecha valor 17-22 · concepto común 23-24 ·
//                           concepto propio 25-27 · clave 28 (1 debe · 2 haber) ·
//                           importe 29-42 · nº documento 43-52 ·
//                           referencia 1 53-64 · referencia 2 65-80
//   23 concepto complem.    código de dato 3-4 · concepto 5-42 · concepto 43-80
//   24 equivalencia divisa  (ignorado)
//   33 final de cuenta      nº apuntes debe 21-25 · total debe 26-39 ·
//                           nº apuntes haber 40-44 · total haber 45-58 ·
//                           clave saldo final 59 · saldo final 60-73 · divisa 74-76
//   88 fin de fichero       nº de registros 21-26
//
// Importes: 14 dígitos con dos decimales implícitos → se leen como céntimos
// enteros (nunca float en la aritmética). Signo: clave 1 = debe = cargo
// (negativo para el titular), clave 2 = haber = abono (positivo). El parser
// es defensivo (registros desconocidos se omiten) pero **honesto**: los totales
// del registro 33 se comprueban y las discrepancias salen en `warnings`.

import { createHash } from "node:crypto";

export type Csb43Movement = {
  /** Fecha de operación YYYY-MM-DD. */
  operationDate: string;
  /** Fecha valor YYYY-MM-DD. */
  valueDate: string;
  /** Concepto común AEB (2 dígitos: 01 reintegros/talones, 02 abonarés, 03 recibos, 04 transferencias…). */
  conceptCode: string;
  /** Concepto propio de la entidad (3 dígitos). */
  ownConceptCode: string;
  /** Importe con signo (+ abono, − cargo). Representación decimal exacta de `amountCents`. */
  amount: number;
  /** Importe en céntimos con signo (la aritmética se hace con esto). */
  amountCents: number;
  /** debit = cargo (clave 1) · credit = abono (clave 2). */
  side: "debit" | "credit";
  /** Conceptos complementarios (registros 23, en orden). */
  descriptions: string[];
  /** Número de documento (registro 22, pos. 43-52). */
  documentNumber: string | null;
  referenceA: string | null;
  referenceB: string | null;
  /** Saldo tras el movimiento (saldo inicial + acumulado). */
  runningBalance: number;
  runningBalanceCents: number;
  /** Línea del fichero del registro 22 (1-based). */
  lineNumber: number;
  /** Huella estable del movimiento (deduplicación al reimportar). */
  fingerprint: string;
};

export type Csb43Account = {
  bankCode: string;
  branchCode: string;
  /** Número de cuenta (10 dígitos, sin dígitos de control). */
  accountNumber: string;
  /** CCC de 20 dígitos (entidad + oficina + DC calculados + cuenta). */
  ccc: string;
  /** IBAN español derivado del CCC (ES + control mod-97). */
  iban: string;
  ownerName: string | null;
  fromDate: string;
  toDate: string;
  currency: string;
  initialBalance: number;
  initialBalanceCents: number;
  /** Saldo final declarado por el registro 33 (0 si falta). */
  finalBalance: number;
  finalBalanceCents: number;
  /** Saldo final calculado (inicial + movimientos). */
  computedFinalBalanceCents: number;
  debitCount: number;
  creditCount: number;
  debitTotalCents: number;
  creditTotalCents: number;
  movements: Csb43Movement[];
  warnings: string[];
};

export type Csb43File = {
  accounts: Csb43Account[];
  /** Registros leídos (líneas no vacías). */
  records: number;
  /** Número de registros declarado por el 88 (null si no hay 88). */
  declaredRecords: number | null;
  warnings: string[];
};

const CURRENCY_BY_CODE: Record<string, string> = {
  "978": "EUR",
  "840": "USD",
  "826": "GBP",
  "756": "CHF"
};

function parseDateYYMMDD(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length !== 6) return "";
  const yy = Number(digits.slice(0, 2));
  const mm = digits.slice(2, 4);
  const dd = digits.slice(4, 6);
  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${mm}-${dd}`;
}

/** 14-digit field with 2 implied decimals + AEB sign key → signed cents. */
function parseCents(field: string, signKey: string): number {
  const digits = field.replace(/\D/g, "");
  if (!digits) return 0;
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents)) return 0;
  // 1 = debe (cargo, negativo para el titular) · 2 = haber (abono, positivo).
  return signKey === "1" ? -cents : cents;
}

function centsToNumber(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function parseCount(field: string): number {
  const digits = field.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

// ---- CCC / IBAN --------------------------------------------------------------

const CCC_WEIGHTS = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];

function cccControlDigit(digits: string): string {
  // Standard Spanish CCC check digit: weights applied right-aligned to 10 positions.
  const padded = digits.padStart(10, "0");
  let total = 0;
  for (let i = 0; i < 10; i++) total += Number(padded[i]) * CCC_WEIGHTS[i]!;
  let dc = 11 - (total % 11);
  if (dc === 11) dc = 0;
  if (dc === 10) dc = 1;
  return String(dc);
}

/** CCC (20 dígitos) a partir de entidad (4), oficina (4) y cuenta (10): calcula los dos dígitos de control. */
export function buildCcc(bankCode: string, branchCode: string, accountNumber: string): string {
  const bank = bankCode.replace(/\D/g, "").padStart(4, "0").slice(-4);
  const branch = branchCode.replace(/\D/g, "").padStart(4, "0").slice(-4);
  const account = accountNumber.replace(/\D/g, "").padStart(10, "0").slice(-10);
  const dc1 = cccControlDigit(bank + branch);
  const dc2 = cccControlDigit(account);
  return `${bank}${branch}${dc1}${dc2}${account}`;
}

/** IBAN de un país + BBAN (mod-97 sobre el reordenado, letras → números). */
export function buildIban(countryCode: string, bban: string): string {
  const rearranged = `${bban}${countryCode}00`;
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(`${remainder}${numeric.slice(i, i + 7)}`) % 97;
  }
  const check = String(98 - remainder).padStart(2, "0");
  return `${countryCode}${check}${bban}`;
}

export function ibanFromCcc(ccc: string): string {
  return buildIban("ES", ccc);
}

// ---- Fingerprint --------------------------------------------------------------

function fingerprintOf(movement: Omit<Csb43Movement, "fingerprint" | "runningBalance" | "runningBalanceCents">, ordinal: number): string {
  const material = [
    movement.operationDate,
    movement.valueDate,
    String(movement.amountCents),
    movement.conceptCode,
    movement.ownConceptCode,
    movement.documentNumber ?? "",
    movement.referenceA ?? "",
    movement.referenceB ?? "",
    movement.descriptions.join(" | "),
    `#${ordinal}`
  ].join("");
  return createHash("sha1").update(material).digest("hex");
}

// ---- Parser ---------------------------------------------------------------------

export function parseCsb43File(content: string): Csb43File {
  const rawLines = content.split(/\r?\n/);
  const accounts: Csb43Account[] = [];
  const warnings: string[] = [];
  let current: Csb43Account | null = null;
  let lastMovement: Csb43Movement | null = null;
  let records = 0;
  let declaredRecords: number | null = null;
  // Identical movements inside one file (same day, amount, concept) are legal:
  // the ordinal keeps their fingerprints distinct.
  const seenMaterial = new Map<string, number>();

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.replace(/\s+$/, "");
    if (raw.length < 2) continue;
    records++;
    const line = raw.padEnd(80, " ");
    const code = line.slice(0, 2);
    const lineNumber = i + 1;

    if (code === "11") {
      const bankCode = line.slice(2, 6).trim();
      const branchCode = line.slice(6, 10).trim();
      const accountNumber = line.slice(10, 20).trim();
      const initialBalanceCents = parseCents(line.slice(33, 47), line.slice(32, 33));
      const ccc = buildCcc(bankCode, branchCode, accountNumber);
      current = {
        bankCode,
        branchCode,
        accountNumber,
        ccc,
        iban: ibanFromCcc(ccc),
        ownerName: line.slice(51, 77).trim() || null,
        fromDate: parseDateYYMMDD(line.slice(20, 26)),
        toDate: parseDateYYMMDD(line.slice(26, 32)),
        currency: CURRENCY_BY_CODE[line.slice(47, 50).trim()] ?? "EUR",
        initialBalance: centsToNumber(initialBalanceCents),
        initialBalanceCents,
        finalBalance: 0,
        finalBalanceCents: 0,
        computedFinalBalanceCents: initialBalanceCents,
        debitCount: 0,
        creditCount: 0,
        debitTotalCents: 0,
        creditTotalCents: 0,
        movements: [],
        warnings: []
      };
      accounts.push(current);
      lastMovement = null;
      continue;
    }

    if (code === "88") {
      declaredRecords = parseCount(line.slice(20, 26));
      continue;
    }

    if (!current) {
      warnings.push(`Línea ${lineNumber}: registro ${code} fuera de una cuenta (falta la cabecera 11); se omite.`);
      continue;
    }

    if (code === "22") {
      const side: "debit" | "credit" = line.slice(27, 28) === "1" ? "debit" : "credit";
      const amountCents = parseCents(line.slice(28, 42), line.slice(27, 28));
      const partial = {
        operationDate: parseDateYYMMDD(line.slice(10, 16)),
        valueDate: parseDateYYMMDD(line.slice(16, 22)),
        conceptCode: line.slice(22, 24).trim(),
        ownConceptCode: line.slice(24, 27).trim(),
        amount: centsToNumber(amountCents),
        amountCents,
        side,
        descriptions: [] as string[],
        documentNumber: line.slice(42, 52).trim().replace(/^0+(?=\d)/, "") || null,
        referenceA: line.slice(52, 64).trim() || null,
        referenceB: line.slice(64, 80).trim() || null,
        lineNumber
      };
      const movement: Csb43Movement = { ...partial, runningBalance: 0, runningBalanceCents: 0, fingerprint: "" };
      current.movements.push(movement);
      lastMovement = movement;
      if (side === "debit") {
        current.debitCount++;
        current.debitTotalCents += Math.abs(amountCents);
      } else {
        current.creditCount++;
        current.creditTotalCents += amountCents;
      }
      current.computedFinalBalanceCents += amountCents;
      movement.runningBalanceCents = current.computedFinalBalanceCents;
      movement.runningBalance = centsToNumber(movement.runningBalanceCents);
      continue;
    }

    if (code === "23") {
      if (!lastMovement) {
        warnings.push(`Línea ${lineNumber}: registro 23 sin movimiento previo; se omite.`);
        continue;
      }
      const concept = `${line.slice(4, 42).trim()} ${line.slice(42, 80).trim()}`.replace(/\s+/g, " ").trim();
      if (concept) lastMovement.descriptions.push(concept);
      continue;
    }

    if (code === "33") {
      const declaredDebitCount = parseCount(line.slice(20, 25));
      const declaredDebitTotal = parseCount(line.slice(25, 39));
      const declaredCreditCount = parseCount(line.slice(39, 44));
      const declaredCreditTotal = parseCount(line.slice(44, 58));
      current.finalBalanceCents = parseCents(line.slice(59, 73), line.slice(58, 59));
      current.finalBalance = centsToNumber(current.finalBalanceCents);
      if (declaredDebitCount !== current.debitCount || declaredCreditCount !== current.creditCount) {
        current.warnings.push(
          `Registro 33: apuntes declarados debe ${declaredDebitCount} / haber ${declaredCreditCount} frente a leídos ${current.debitCount} / ${current.creditCount}.`
        );
      }
      if (declaredDebitTotal !== current.debitTotalCents || declaredCreditTotal !== current.creditTotalCents) {
        current.warnings.push(
          `Registro 33: totales declarados debe ${centsToNumber(declaredDebitTotal).toFixed(2)} / haber ${centsToNumber(declaredCreditTotal).toFixed(2)} frente a leídos ${centsToNumber(current.debitTotalCents).toFixed(2)} / ${centsToNumber(current.creditTotalCents).toFixed(2)}.`
        );
      }
      if (current.finalBalanceCents !== current.computedFinalBalanceCents) {
        current.warnings.push(
          `Registro 33: saldo final declarado ${current.finalBalance.toFixed(2)} ≠ saldo inicial + movimientos ${centsToNumber(current.computedFinalBalanceCents).toFixed(2)}.`
        );
      }
      // Fingerprints once the concept lines are complete.
      for (const movement of current.movements) {
        const material = fingerprintOf(movement, 0);
        const ordinal = (seenMaterial.get(material) ?? 0) + 1;
        seenMaterial.set(material, ordinal);
        movement.fingerprint = fingerprintOf(movement, ordinal);
      }
      current = null;
      lastMovement = null;
      continue;
    }

    // Registro 24 (equivalencia en otra divisa) y desconocidos: se omiten.
  }

  // Accounts without a closing 33 record: fingerprints still need computing.
  for (const account of accounts) {
    if (account.movements.some((m) => !m.fingerprint)) {
      account.warnings.push("Falta el registro 33 de cierre de cuenta: totales sin comprobar.");
      for (const movement of account.movements) {
        if (movement.fingerprint) continue;
        const material = fingerprintOf(movement, 0);
        const ordinal = (seenMaterial.get(material) ?? 0) + 1;
        seenMaterial.set(material, ordinal);
        movement.fingerprint = fingerprintOf(movement, ordinal);
      }
    }
  }

  if (declaredRecords !== null && declaredRecords !== records - 1) {
    warnings.push(`Registro 88: declara ${declaredRecords} registros y el fichero tiene ${records - 1} (sin contar el 88).`);
  }

  return { accounts, records, declaredRecords, warnings };
}

/** Compatibilidad: solo las cuentas (los avisos van en cada cuenta y en `parseCsb43File`). */
export function parseCsb43(content: string): Csb43Account[] {
  return parseCsb43File(content).accounts;
}

// ---------------------------------------------------------------------------
// Conciliación en memoria (compatibilidad con la pantalla «Extractos y remesas»)
// ---------------------------------------------------------------------------
// La conciliación persistida vive en modules/banking (matching.core.ts +
// reconciliation.service.ts); este emparejador solo sirve para la vista previa
// y usa las mismas reglas: importe exacto (céntimos) + referencia, o importe +
// fecha a ±3 días.

export type ReconciliationMatch = {
  movementIndex: number;
  paymentId: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type ReconciliationCandidate = {
  paymentId: string;
  /** Importe positivo (cobro). */
  amount: number;
  pspReference: string | null;
  createdAt: Date;
};

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function reconcileMovements(
  movements: Csb43Movement[],
  candidates: ReconciliationCandidate[]
): { matches: ReconciliationMatch[]; unmatchedMovements: number[]; unmatchedPayments: string[] } {
  const matches: ReconciliationMatch[] = [];
  const usedPayments = new Set<string>();
  const usedMovements = new Set<number>();

  // 1ª pasada: importe exacto + referencia del PSP en los conceptos.
  for (let i = 0; i < movements.length; i++) {
    const m = movements[i]!;
    if (m.amountCents <= 0) continue; // solo cobros
    const haystack = `${m.descriptions.join(" ")} ${m.referenceA ?? ""} ${m.referenceB ?? ""} ${m.documentNumber ?? ""}`.toLowerCase();
    for (const c of candidates) {
      if (usedPayments.has(c.paymentId)) continue;
      const sameAmount = toCents(c.amount) === m.amountCents;
      const refMatch = Boolean(c.pspReference) && haystack.includes(c.pspReference!.toLowerCase());
      if (sameAmount && refMatch) {
        matches.push({ movementIndex: i, paymentId: c.paymentId, confidence: "high", reason: "importe + referencia" });
        usedPayments.add(c.paymentId);
        usedMovements.add(i);
        break;
      }
    }
  }

  // 2ª pasada: importe exacto + fecha a ±3 días.
  for (let i = 0; i < movements.length; i++) {
    if (usedMovements.has(i)) continue;
    const m = movements[i]!;
    if (m.amountCents <= 0) continue;
    const opDate = new Date(`${m.operationDate}T00:00:00Z`);
    for (const c of candidates) {
      if (usedPayments.has(c.paymentId)) continue;
      const sameAmount = toCents(c.amount) === m.amountCents;
      const daysDiff = Math.abs(c.createdAt.getTime() - opDate.getTime()) / 86_400_000;
      if (sameAmount && daysDiff <= 3) {
        matches.push({ movementIndex: i, paymentId: c.paymentId, confidence: "medium", reason: `importe + ${Math.round(daysDiff)} día(s) de diferencia` });
        usedPayments.add(c.paymentId);
        usedMovements.add(i);
        break;
      }
    }
  }

  const unmatchedMovements = movements.map((_, i) => i).filter((i) => !usedMovements.has(i));
  const unmatchedPayments = candidates.filter((c) => !usedPayments.has(c.paymentId)).map((c) => c.paymentId);
  return { matches, unmatchedMovements, unmatchedPayments };
}

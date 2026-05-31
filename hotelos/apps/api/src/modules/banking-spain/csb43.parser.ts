// Parser de extractos bancarios españoles CSB Norma 43 (también ISO 20022 CAMT-053
// para bancos modernos). Norma 43 es texto fijo de 80 columnas por línea con
// 8 tipos de registro. Documentada por AEB ("Cuaderno 43").
//
// Estructura mínima implementada:
//   - Registro 11: Cabecera de cuenta (banco, sucursal, número, divisa,
//     fechas iniciales/finales, saldo inicial).
//   - Registro 22: Movimiento principal (fecha operación, fecha valor,
//     concepto común, importe, saldo).
//   - Registro 23: Conceptos complementarios (texto libre, hasta 5).
//   - Registro 24: Equivalencia en otra divisa (opcional).
//   - Registro 33: Cierre de cuenta (saldo final, totales debe/haber, número
//     de movimientos).
//   - Registro 88: Cierre de fichero (totales globales).
//
// El parser es **defensivo**: si encuentra una línea de tipo desconocido, la
// omite y continúa. Cualquier hotel español puede subir su extracto sin
// hablar con su banco; el módulo de conciliación luego matchea contra
// payments + invoices.

export type Csb43Account = {
  bankCode: string;
  branchCode: string;
  accountNumber: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;
  currency: string;
  initialBalance: number;
  finalBalance: number;
  movements: Csb43Movement[];
};

export type Csb43Movement = {
  /** Operation date (fecha operación). */
  operationDate: string;
  /** Value date (fecha valor). */
  valueDate: string;
  /** Concepto común (código numérico AEB). */
  conceptCode: string;
  /** Amount in account currency. Sign: + ingreso, - cargo. */
  amount: number;
  /** Free-text concepts (up to 5 lines from registros 23). */
  descriptions: string[];
  /** Reference number / document number if present. */
  referenceA: string | null;
  referenceB: string | null;
  /** Running balance after this movement. */
  runningBalance: number;
};

const DATE_LEN = 6; // YYMMDD

function parseDateYYMMDD(s: string): string {
  const yy = Number(s.slice(0, 2));
  const mm = s.slice(2, 4);
  const dd = s.slice(4, 6);
  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${mm}-${dd}`;
}

function parseAmount(s: string, signFlag: string): number {
  // 14 digits, last 2 are decimals (e.g. "00000001500" + flag "2" = -15.00).
  // Flag '1' = abono, '2' = adeudo.
  const integer = Number(s.replace(/\D/g, ""));
  if (Number.isNaN(integer)) return 0;
  const amount = integer / 100;
  return signFlag === "2" ? -amount : amount;
}

const CURRENCY_BY_CODE: Record<string, string> = {
  "978": "EUR",
  "840": "USD",
  "826": "GBP",
  "756": "CHF"
};

export function parseCsb43(content: string): Csb43Account[] {
  const lines = content.split(/\r?\n/);
  const accounts: Csb43Account[] = [];
  let current: Csb43Account | null = null;
  let lastMovement: Csb43Movement | null = null;

  for (const raw of lines) {
    if (raw.length < 2) continue;
    const code = raw.slice(0, 2);
    const rest = raw;

    if (code === "11") {
      // Header de cuenta
      const account = {
        bankCode: rest.slice(2, 6).trim(),
        branchCode: rest.slice(6, 10).trim(),
        accountNumber: rest.slice(10, 20).trim(),
        fromDate: parseDateYYMMDD(rest.slice(20, 26)),
        toDate: parseDateYYMMDD(rest.slice(26, 32)),
        initialBalance: parseAmount(rest.slice(32, 46), rest.slice(46, 47) || "1"),
        currency: CURRENCY_BY_CODE[rest.slice(47, 50).trim()] ?? "EUR",
        finalBalance: 0,
        movements: []
      } as Csb43Account;
      current = account;
      accounts.push(account);
      continue;
    }

    if (!current) continue;

    if (code === "22") {
      const movement: Csb43Movement = {
        operationDate: parseDateYYMMDD(rest.slice(10, 16)),
        valueDate: parseDateYYMMDD(rest.slice(16, 22)),
        conceptCode: rest.slice(22, 24).trim(),
        amount: parseAmount(rest.slice(28, 42), rest.slice(27, 28) || "1"),
        descriptions: [],
        referenceA: rest.slice(52, 64).trim() || null,
        referenceB: rest.slice(64, 80).trim() || null,
        runningBalance: 0
      };
      current.movements.push(movement);
      lastMovement = movement;
    } else if (code === "23" && lastMovement) {
      // Conceptos complementarios — texto libre.
      const description = rest.slice(4, 80).trim();
      if (description) lastMovement.descriptions.push(description);
    } else if (code === "33") {
      // Cierre de cuenta — totales.
      current.finalBalance = parseAmount(rest.slice(40, 54), rest.slice(54, 55) || "1");
      // Recalculate running balance per movement (Norma 43 doesn't include it
      // per-line; we compute from initial + cumulative).
      let running = current.initialBalance;
      for (const m of current.movements) {
        running = Math.round((running + m.amount) * 100) / 100;
        m.runningBalance = running;
      }
      current = null;
      lastMovement = null;
    }
    // Registros 24 (divisa equivalente) y 88 (cierre fichero) los ignoramos.
  }

  return accounts;
}

// ---------------------------------------------------------------------------
// Conciliación bancaria: matchear movimientos con Payments del PMS
// ---------------------------------------------------------------------------

export type ReconciliationMatch = {
  movementIndex: number;
  paymentId: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type ReconciliationCandidate = {
  paymentId: string;
  amount: number;
  pspReference: string | null;
  createdAt: Date;
};

export function reconcileMovements(
  movements: Csb43Movement[],
  candidates: ReconciliationCandidate[]
): { matches: ReconciliationMatch[]; unmatchedMovements: number[]; unmatchedPayments: string[] } {
  const matches: ReconciliationMatch[] = [];
  const usedPayments = new Set<string>();
  const usedMovements = new Set<number>();

  // 1st pass: exact match by amount + pspReference appearing in concept lines.
  for (let i = 0; i < movements.length; i++) {
    const m = movements[i];
    if (m.amount <= 0) continue; // we only conciliate cobros (positive)
    const desc = m.descriptions.join(" ").toLowerCase() + " " + (m.referenceA ?? "") + " " + (m.referenceB ?? "");
    for (const c of candidates) {
      if (usedPayments.has(c.paymentId)) continue;
      const sameAmount = Math.abs(c.amount - m.amount) < 0.01;
      const refMatch = c.pspReference && desc.toLowerCase().includes(c.pspReference.toLowerCase());
      if (sameAmount && refMatch) {
        matches.push({ movementIndex: i, paymentId: c.paymentId, confidence: "high", reason: "amount + pspReference match" });
        usedPayments.add(c.paymentId);
        usedMovements.add(i);
        break;
      }
    }
  }

  // 2nd pass: by amount + date proximity (within 3 days).
  for (let i = 0; i < movements.length; i++) {
    if (usedMovements.has(i)) continue;
    const m = movements[i];
    if (m.amount <= 0) continue;
    const opDate = new Date(m.operationDate);
    for (const c of candidates) {
      if (usedPayments.has(c.paymentId)) continue;
      const sameAmount = Math.abs(c.amount - m.amount) < 0.01;
      const daysDiff = Math.abs(c.createdAt.getTime() - opDate.getTime()) / 86_400_000;
      if (sameAmount && daysDiff <= 3) {
        matches.push({ movementIndex: i, paymentId: c.paymentId, confidence: "medium", reason: `amount match + ${Math.round(daysDiff)}d apart` });
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

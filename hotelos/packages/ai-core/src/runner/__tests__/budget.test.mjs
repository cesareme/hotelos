// Presupuesto mensual por propiedad: importe desde configurationJson con
// respaldo al defecto y comparación con el gasto del mes.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { MONTHLY_BUDGET_KEY, budgetStatus, isBudgetExceeded, monthlyBudgetEurOf } from "../budget.ts";

test("monthlyBudgetEurOf: número ≥ 0 → ese valor; null, ausente, negativo o no numérico → el defecto", () => {
  assert.equal(MONTHLY_BUDGET_KEY, "monthlyBudgetEur");
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: 40 }, 25), 40);
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: 0 }, 25), 0, "0 es un presupuesto válido (bloquea)");
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: "12.5" }, 25), 12.5, "cadena numérica admitida");
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: null }, 25), 25);
  assert.equal(monthlyBudgetEurOf({}, 25), 25);
  assert.equal(monthlyBudgetEurOf(null, 25), 25);
  assert.equal(monthlyBudgetEurOf("{}", 25), 25);
  assert.equal(monthlyBudgetEurOf([], 25), 25);
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: -3 }, 25), 25);
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: "abc" }, 25), 25);
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: Number.NaN }, 25), 25);
  assert.equal(monthlyBudgetEurOf({ monthlyBudgetEur: null }, -1), 0, "un defecto inválido nunca produce un presupuesto negativo");
});

test("isBudgetExceeded: gasto ≥ presupuesto; presupuesto 0 siempre excedido; null sin límite", () => {
  assert.equal(isBudgetExceeded(25, 25), true);
  assert.equal(isBudgetExceeded(24.99, 25), false);
  assert.equal(isBudgetExceeded(0, 0), true);
  assert.equal(isBudgetExceeded(0, 25), false);
  assert.equal(isBudgetExceeded(1_000, null), false);
  assert.equal(isBudgetExceeded(Number.NaN, 25), false, "gasto no numérico cuenta como 0");
  assert.equal(isBudgetExceeded(5, Number.NaN), true, "presupuesto no numérico bloquea (nunca gasto sin control)");
});

test("budgetStatus resume presupuesto, gasto, restante y excedido", () => {
  assert.deepEqual(budgetStatus(3.5, 25), { budgetEur: 25, spentEur: 3.5, remainingEur: 21.5, exceeded: false });
  assert.deepEqual(budgetStatus(30, 25), { budgetEur: 25, spentEur: 30, remainingEur: 0, exceeded: true });
  assert.deepEqual(budgetStatus(-2, null), { budgetEur: null, spentEur: 0, remainingEur: null, exceeded: false });
});

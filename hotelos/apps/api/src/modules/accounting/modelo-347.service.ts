// Finanzas · lote «iva-modelos» — Modelo 347 (declaración anual de operaciones
// con terceras personas).
//
// From the VAT books of the year: every third party (NIF) whose operations
// with the organisation exceed 3.005,06 € (IVA included) in the year is
// declared, with the quarterly breakdown the form asks for:
//   · clave A = adquisiciones (recibidas + bienes de inversión),
//   · clave B = entregas de bienes y prestaciones de servicios (emitidas).
// Excluded, as the 347 rules require, and reported in `avisos`:
//   · rows without counterparty NIF (simplified invoices, tickets),
//   · operations subject to IRPF withholding (they go in 111/115/190).
// Not modelled (avisos): cash collections above 6.000 € per person, insurance
// and leasing special keys, transmissions of real estate. The official 347
// record layout is not generated (presentación manual). Read-only.

import { Prisma } from "@prisma/client";
import type { FiscalBox, FiscalModelReport, VatBookName } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireYear } from "../../lib/query-dates.js";
import { PRESENTACION_MANUAL_NOTA, declaranteOf } from "./modelo-303.service.js";
import { ZERO, annualPeriod, getVatSettings, loadVatBookRows, quarterOfDay, round2, summarizeVatRows, toWire, type Money, type VatBookRow } from "./vat-books.service.js";

export const MODELO_347_TITLE = "Modelo 347 · Declaración anual de operaciones con terceras personas";

/** Art. 33 RD 1065/2007: operaciones con una misma persona que superen 3.005,06 € en el año. */
export const MODELO_347_THRESHOLD = new Prisma.Decimal("3005.06");

export type Modelo347Clave = "A" | "B";

export type Modelo347Declarado = {
  nif: string;
  nombre: string | null;
  clave: Modelo347Clave;
  importeAnual: Money;
  trimestres: [Money, Money, Money, Money];
  filas: number;
};

export type Modelo347Computation = {
  declarados: Modelo347Declarado[];
  bajoUmbral: number;
  sinNif: { filas: number; importe: Money };
  conRetencion: { filas: number; importe: Money };
  importeTotal: Money;
  casillas: FiscalBox[];
  totales: Record<string, number>;
  avisos: string[];
};

function claveOf(book: VatBookName): Modelo347Clave {
  return book === "emitidas" ? "B" : "A";
}

/** Pure: third parties over the threshold from the year's book rows. */
export function compute347(rows: readonly VatBookRow[]): Modelo347Computation {
  const avisos: string[] = [];
  const groups = new Map<string, Modelo347Declarado>();
  const sinNif = { filas: 0, importe: ZERO };
  const conRetencion = { filas: 0, importe: ZERO };
  for (const row of rows) {
    if (!row.retention.isZero()) {
      conRetencion.filas += 1;
      conRetencion.importe = conRetencion.importe.plus(row.total);
      continue;
    }
    if (!row.counterpartyNif) {
      sinNif.filas += 1;
      sinNif.importe = sinNif.importe.plus(row.total);
      continue;
    }
    const clave = claveOf(row.book);
    const key = `${row.counterpartyNif}|${clave}`;
    const group = groups.get(key) ?? { nif: row.counterpartyNif, nombre: row.counterpartyName, clave, importeAnual: ZERO, trimestres: [ZERO, ZERO, ZERO, ZERO], filas: 0 };
    const quarter = quarterOfDay(row.date) - 1;
    group.importeAnual = group.importeAnual.plus(row.total);
    group.trimestres[quarter] = group.trimestres[quarter]!.plus(row.total);
    group.filas += 1;
    if (!group.nombre && row.counterpartyName) group.nombre = row.counterpartyName;
    groups.set(key, group);
  }
  const all = Array.from(groups.values());
  const declarados = all
    .filter((group) => group.importeAnual.abs().greaterThan(MODELO_347_THRESHOLD))
    .map((group) => ({ ...group, importeAnual: round2(group.importeAnual), trimestres: group.trimestres.map(round2) as [Money, Money, Money, Money] }))
    .sort((a, b) => b.importeAnual.abs().comparedTo(a.importeAnual.abs()) || a.nif.localeCompare(b.nif));
  const bajoUmbral = all.length - declarados.length;
  const importeTotal = round2(declarados.reduce((sum, group) => sum.plus(group.importeAnual), ZERO));
  if (sinNif.filas > 0) avisos.push(`${sinNif.filas} fila(s) sin NIF del tercero (${round2(sinNif.importe).toFixed(2)} €) excluidas: facturas simplificadas y tickets no se declaran en el 347.`);
  if (conRetencion.filas > 0) avisos.push(`${conRetencion.filas} fila(s) con retención IRPF (${round2(conRetencion.importe).toFixed(2)} €) excluidas: se declaran en los modelos 111/115/190, no en el 347.`);
  if (bajoUmbral > 0) avisos.push(`${bajoUmbral} tercero(s) por debajo del umbral de 3.005,06 € no se declaran.`);
  avisos.push("No se controlan cobros en metálico superiores a 6.000 € por persona ni las claves especiales (seguros, arrendamientos de locales, transmisiones de inmuebles): revisar con la gestoría.");
  const casillas: FiscalBox[] = [
    { casilla: null, clave: "NUM_DECLARADOS", descripcion: "Número total de personas y entidades relacionadas", seccion: "Resumen de los datos", importe: declarados.length, tipo: "contador" },
    { casilla: null, clave: "IMPORTE_TOTAL", descripcion: "Importe total de las operaciones relacionadas", seccion: "Resumen de los datos", importe: toWire(importeTotal), tipo: "info" }
  ];
  return {
    declarados,
    bajoUmbral,
    sinNif,
    conRetencion,
    importeTotal,
    casillas,
    totales: {
      declarados: declarados.length,
      importeTotal: toWire(importeTotal),
      tercerosBajoUmbral: bajoUmbral,
      filasSinNif: sinNif.filas,
      importeSinNif: toWire(sinNif.importe),
      filasConRetencion: conRetencion.filas,
      importeConRetencion: toWire(conRetencion.importe)
    },
    avisos
  };
}

export async function buildModelo347(input: { context: UserContext; propertyId?: string | null; year: number }): Promise<FiscalModelReport> {
  requirePermissions(input.context, ["accounting.read"]);
  const year = requireYear(input.year);
  const organizationId = input.context.organizationId;
  const settings = await getVatSettings(organizationId);
  const periodo = annualPeriod(year);
  const loaded = await loadVatBookRows({ organizationId, from: periodo.from, to: periodo.to, propertyId: input.propertyId, periodicity: settings.periodicity, taxFigure: settings.taxFigure });
  const computation = compute347(loaded.rows);
  const avisos = [...loaded.avisos, ...computation.avisos];
  if (input.propertyId) avisos.push("Vista parcial por establecimiento: el Modelo 347 se presenta por NIF (organización) y el umbral se evalúa sobre todas las propiedades.");
  const summary = (book: VatBookName) => summarizeVatRows(loaded.rows.filter((row) => row.book === book));
  const anyDerived = (Object.values(loaded.origen) as Array<"libros" | "documentos">).some((origen) => origen === "documentos");
  return {
    modelo: "347",
    titulo: MODELO_347_TITLE,
    organizationId,
    propertyId: input.propertyId ?? null,
    periodo,
    declarante: await declaranteOf(organizationId),
    casillas: computation.casillas,
    totales: computation.totales,
    avisos,
    fuentes: {
      origen: anyDerived ? "documentos" : "libros",
      libros: { emitidas: summary("emitidas"), recibidas: summary("recibidas"), bienes_inversion: summary("bienes_inversion") },
      registros: loaded.rows.length
    },
    detalle: computation.declarados.map((declarado) => ({
      nif: declarado.nif,
      nombre: declarado.nombre,
      clave: declarado.clave,
      importeAnual: toWire(declarado.importeAnual),
      t1: toWire(declarado.trimestres[0]),
      t2: toWire(declarado.trimestres[1]),
      t3: toWire(declarado.trimestres[2]),
      t4: toWire(declarado.trimestres[3]),
      filas: declarado.filas
    })),
    presentacion: { modo: "manual", ficheroOficial: false, nota: PRESENTACION_MANUAL_NOTA },
    generatedAt: new Date().toISOString()
  };
}

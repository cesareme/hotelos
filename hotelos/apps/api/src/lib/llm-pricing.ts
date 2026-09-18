// Tabla de precios y coste desde `usage` (DOCUMENTOS §5.2): re-export de @hotelos/ai-core.
// PRICING_TABLE_DATE es la fecha de la tabla; se actualiza en el humo manual con clave.
export { PRICING_TABLE_DATE, PRICING_TABLE, PRICING_MULTIPLIERS, costFromUsage, pricingForModel } from "@hotelos/ai-core";
export type { AiCost, ModelPricing, PricingUsage } from "@hotelos/ai-core";

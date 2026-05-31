export const OWNER_GUIDE = {
  persona: "Owner",
  dailyFlow: [
    "Abrir P&L vista del activo (revenue, GOP, EBITDA, margen) con periodo MTD y comparar contra prior year.",
    "Revisar occupancy YTD vs budget vs prior year e identificar el gap acumulado por canal y segmento.",
    "Comparar REVPAR vs comp-set (rate shopper) para validar el posicionamiento de mercado y el RGI.",
    "Cruzar budget vs actual por linea (rooms, F&B, otros) y marcar las desviaciones criticas para seguimiento.",
    "Repasar asset-level health: CAPEX en curso, mantenimiento mayor, ratios operativos del activo y cumplimiento legal.",
  ],
  tips: [
    "Portfolio rollup multi-property: vista consolidada weighted por habitaciones, con drill-down por propiedad y por marca.",
    "Alertas critical cross-property: overbookings, incidencias mayores, desviaciones de budget >10%, cash flow negativo o saldos pendientes anomalos.",
    "REVPAR Index (RGI) vs comp-set debe estar >100 para liderar el mercado; <90 exige revision urgente de pricing y mix de canales.",
    "El owner no opera el dia a dia: si te encuentras revisando check-ins o overbookings, escala al GM en lugar de intervenir.",
    "Cuadra el P&L mensual con la tesoreria real antes de cualquier decision de distribucion de dividendos o reinversion en CAPEX.",
  ],
  relatedScreens: [
    "OwnerHome",
    "PortfolioDashboard",
    "GeneralManagerScreen",
    "FinancePositionDashboard",
    "RevenueHomeDashboard",
  ],
} as const;

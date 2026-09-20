// Tab containers registry (Tanda 5 · L1a → L1b handoff).
//
// L1a lots that merge screens into a routed tab container (CocoaRouteTabs,
// `/x/y/:tab`) export it from here, ONE line per container, without touching
// App.tsx. L1b registers each export in SCREEN_COMPONENTS and in the routes
// table at the URL of pilots/tanda5-nav-tree.csv (see nav-tree.generated.json).
//
//   export { default as ReservationsTabs } from "./ReservationsTabs";
//
// Rules: the container renders CocoaPageHeader once and passes `basePath` =
// the item URL of the tree; tab keys = the last URL segment of each tab;
// screens keep working at their legacy routes until L1b flips the router.
// --- Lote tabs-b (Comercial · Revenue · Finanzas · Informes) ---------------
export { default as ClientesTabs } from "./comercial/ClientesTabs";
export { default as ReputacionTabs } from "./comercial/ReputacionTabs";
export { default as VentasAdicionalesTabs } from "./comercial/VentasAdicionalesTabs";
export { default as CanalesTabs } from "./comercial/CanalesTabs";
export { default as ParrillaTabs } from "./revenue/ParrillaTabs";
export { default as HistoricoPrevisionTabs } from "./revenue/HistoricoPrevisionTabs";
export { default as FacturacionTabs } from "./finanzas/FacturacionTabs";
export { default as TesoreriaTabs } from "./finanzas/TesoreriaTabs";
export { default as ConciliacionTabs } from "./finanzas/ConciliacionTabs";
export { default as EstadosContablesTabs } from "./finanzas/EstadosContablesTabs";
// Tanda 6 · Finanzas (lote nav-services): Contabilidad y Proveedores y gastos.
export { default as ContabilidadTabs } from "./finanzas/ContabilidadTabs";
export { default as NominasTabs } from "./finanzas/NominasTabs";
export { default as ProveedoresTabs } from "./finanzas/ProveedoresTabs";
export { default as CentroInformesTabs } from "./informes/CentroInformesTabs";
export { default as CarteraTabs } from "./informes/CarteraTabs";

// Lote tabs-a (Hoy · Recepción · Operaciones) — L1b registers each at the URL of the tree.
export { default as MiDiaTabs } from "./hoy/MiDiaTabs";
export { default as ReservasTabs } from "./recepcion/ReservasTabs";
export { default as NuevaReservaTabs } from "./recepcion/NuevaReservaTabs";
export { default as HuespedesTabs } from "./recepcion/HuespedesTabs";
export { default as GruposEventosTabs } from "./recepcion/GruposEventosTabs";
export { default as PisosTabs } from "./operaciones/PisosTabs";
export { default as MantenimientoTabs } from "./operaciones/MantenimientoTabs";
export { default as PuntoVentaTabs } from "./operaciones/PuntoVentaTabs";
export { default as ComprasInventarioTabs } from "./operaciones/ComprasInventarioTabs";

// Lote tabs-c (Cumplimiento · Configuración) — L1b registers each at the URL of the tree.
export { default as VerifactuTabs } from "./cumplimiento/VerifactuTabs";
export { default as ModelosAeatTabs } from "./cumplimiento/ModelosAeatTabs";
export { default as ImpuestosTabs } from "./cumplimiento/ImpuestosTabs";
export { default as RegistroViajerosTabs } from "./cumplimiento/RegistroViajerosTabs";
export { default as SostenibilidadTabs } from "./cumplimiento/SostenibilidadTabs";
export { default as PuestaEnMarchaTabs } from "./configuracion/PuestaEnMarchaTabs";
export { default as PropiedadTabs } from "./configuracion/PropiedadTabs";
export { default as HabitacionesTabs } from "./configuracion/HabitacionesTabs";
export { default as ComunicacionesTabs } from "./configuracion/ComunicacionesTabs";
export { default as FacturacionPagosTabs } from "./configuracion/FacturacionPagosTabs";
export { default as ContabilidadFiscalTabs } from "./configuracion/ContabilidadFiscalTabs";
export { default as ModulosTabs } from "./configuracion/ModulosTabs";
export { default as InteligenciaArtificialTabs } from "./configuracion/InteligenciaArtificialTabs";
export { default as SistemaTabs } from "./configuracion/SistemaTabs";
// Tanda 6b · L6: Configuración › Estructura societaria (Datos fiscales · Centros · Series y VeriFactu · IVA y ejercicio · Reparto).
export { default as EstructuraSocietariaTabs } from "./configuracion/EstructuraSocietariaTabs";


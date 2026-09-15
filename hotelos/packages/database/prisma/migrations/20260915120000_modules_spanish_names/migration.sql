-- Tanda 5 · L1b (api-side) · 2026-09-15 · Spanish names and descriptions for the
-- `modules` catalog rows. Data-only migration, hand-written: `prisma migrate diff`
-- produces nothing because schema.prisma did not change. Source of truth:
-- packages/product/src/modules/module-manifest.ts (HOTEL_MODULES.name/description,
-- Spanish since L1a · product-manifest). The API only reads modules.name from the
-- manifest (GET /backoffice/properties/:id/modules spreads it), so this aligns the
-- database with what hoteliers already see. Rows are matched by `code`; a code that
-- does not exist is skipped (fresh install → empty table → no-op), createMany
-- skipDuplicates / upsert update {} in product-modules.service never rename, and
-- re-running is idempotent. Codes: 33 (the whole manifest).

UPDATE "modules" SET "name" = 'Núcleo PMS', "description" = 'Reservas, habitaciones, huéspedes, estancias, folios y operativa de recepción.' WHERE "code" = 'pms_core';
UPDATE "modules" SET "name" = 'Recepción con IA', "description" = 'Centro de mando por voz, texto y cámara para la operativa de recepción.' WHERE "code" = 'ai_front_desk';
UPDATE "modules" SET "name" = 'Canales de venta', "description" = 'Disponibilidad, tarifas, restricciones, correspondencias de canales, importación de reservas y registros de sincronización.' WHERE "code" = 'distribution_hub';
UPDATE "modules" SET "name" = 'Motor de reservas con IA', "description" = 'Cotizaciones de disponibilidad para el huésped, borradores de reserva, enlaces de pago y confirmaciones.' WHERE "code" = 'ai_booking_engine';
UPDATE "modules" SET "name" = 'Check-in en línea', "description" = 'Check-in en línea y asistido con OCR, firma, cola de cumplimiento y traza de auditoría.' WHERE "code" = 'checkin_online';
UPDATE "modules" SET "name" = 'Pisos', "description" = 'Tablero de limpieza, inspecciones, notas de minibar, objetos perdidos y sincronización de tareas sin conexión.' WHERE "code" = 'housekeeping';
UPDATE "modules" SET "name" = 'Mantenimiento', "description" = 'Partes de avería, bloqueo de habitaciones, adjuntos, mantenimiento preventivo e historial de activos.' WHERE "code" = 'maintenance';
UPDATE "modules" SET "name" = 'Contabilidad', "description" = 'Libro de doble partida, facturas de proveedor, conciliación bancaria, cierre de periodo y cuentas anuales.' WHERE "code" = 'erp_accounting';
UPDATE "modules" SET "name" = 'Cumplimiento', "description" = 'Registro de viajeros, partes de entrada firmados, cola SES.Hospedajes y bandeja de cumplimiento.' WHERE "code" = 'compliance_hub';
UPDATE "modules" SET "name" = 'Facturación fiscal', "description" = 'Facturación inmutable, rectificativas, estado preparado para VeriFactu y adaptadores de factura electrónica.' WHERE "code" = 'compliance_billing';
UPDATE "modules" SET "name" = 'Pagos', "description" = 'Conexiones con pasarelas, enlaces de pago, pagos tokenizados, SCA/3DS, depósitos y aprobación de devoluciones.' WHERE "code" = 'payment_vault';
UPDATE "modules" SET "name" = 'Experiencia del huésped', "description" = 'Bandeja unificada de huéspedes, solicitudes de servicio, sentimiento, encuestas, ventas adicionales y recuperación de quejas.' WHERE "code" = 'guest_experience';
UPDATE "modules" SET "name" = 'Conserje con IA', "description" = 'Respuestas al huésped con IA, recomendaciones locales, creación de solicitudes de servicio y traspaso a una persona.' WHERE "code" = 'ai_concierge';
UPDATE "modules" SET "name" = 'Activos', "description" = 'Rentabilidad por habitación, coste de mantenimiento por habitación, garantías, certificados y estado de conservación.' WHERE "code" = 'asset_intelligence';
UPDATE "modules" SET "name" = 'Inversiones (capex)', "description" = 'Proyectos de inversión, retorno de reformas, aprobaciones del propietario y planes ligados a habitaciones o activos.' WHERE "code" = 'capex_manager';
UPDATE "modules" SET "name" = 'Punto de venta', "description" = 'Pedidos de restaurante, bar, spa, aparcamiento, minibar, eventos, tienda, traslados y cargos a habitación.' WHERE "code" = 'outlet_pos';
UPDATE "modules" SET "name" = 'Modo propietario', "description" = 'Informe del propietario: ocupación, ADR, RevPAR, caja, deudores, mantenimiento, cumplimiento e inversiones.' WHERE "code" = 'owner_mode';
UPDATE "modules" SET "name" = 'Integraciones', "description" = 'Catálogo de proveedores, estado de conexión, prueba de conexión, registros de sincronización y referencias de credenciales.' WHERE "code" = 'integration_marketplace';
UPDATE "modules" SET "name" = 'Gestor de módulos', "description" = 'Catálogo de módulos por propiedad, estado de activación y activación que respeta las dependencias.' WHERE "code" = 'module_marketplace';
UPDATE "modules" SET "name" = 'Revenue y rentabilidad', "description" = 'Previsión, precios dinámicos, gestión de canales, restricciones, inteligencia tarifaria, predicción de demanda y optimización del beneficio.' WHERE "code" = 'revenue_profit_engine';
UPDATE "modules" SET "name" = 'Clientes y fidelización', "description" = 'Perfil único del huésped, segmentación, campañas, fidelización y personalización.' WHERE "code" = 'guest_data_crm_loyalty';
UPDATE "modules" SET "name" = 'Grupos, eventos y ventas', "description" = 'Reservas de grupo, cupos, espacios para eventos, propuestas, órdenes de evento y facturación de grupos.' WHERE "code" = 'groups_events_sales';
UPDATE "modules" SET "name" = 'Personal y turnos', "description" = 'Cuadrantes, fichajes, previsión de personal, gestión de turnos y productividad.' WHERE "code" = 'workforce_labor';
UPDATE "modules" SET "name" = 'Compras e inventario', "description" = 'Proveedores, pedidos de compra, existencias, lencería, minibar, repuestos y conciliación a tres bandas.' WHERE "code" = 'procurement_inventory';
UPDATE "modules" SET "name" = 'Portal del huésped', "description" = 'Portal del huésped, check-in y check-out desde el móvil, kiosco, llaves digitales y ventas adicionales.' WHERE "code" = 'guest_self_service';
UPDATE "modules" SET "name" = 'Reputación y calidad', "description" = 'Agregación de reseñas, análisis de sentimiento, encuestas, casos de calidad y recuperación del servicio.' WHERE "code" = 'reputation_quality';
UPDATE "modules" SET "name" = 'Energía y sostenibilidad', "description" = 'Energía, agua, residuos, ESG, contadores inteligentes e informes de sostenibilidad.' WHERE "code" = 'energy_sustainability';
UPDATE "modules" SET "name" = 'Seguridad e incidentes', "description" = 'Registro de incidentes, protocolos de emergencia, controles de seguridad, evidencias para el seguro y gestión de riesgos.' WHERE "code" = 'safety_incident_management';
UPDATE "modules" SET "name" = 'Analítica', "description" = 'Almacén de datos, métricas semánticas, inteligencia de negocio, detección de anomalías y analítica en lenguaje natural.' WHERE "code" = 'hotel_intelligence_platform';
UPDATE "modules" SET "name" = 'Plataforma para desarrolladores', "description" = 'API pública, aplicaciones OAuth, webhooks, entorno de pruebas, registros de API y certificación de socios.' WHERE "code" = 'developer_platform';
UPDATE "modules" SET "name" = 'Gobernanza de la IA', "description" = 'Centro de políticas de IA, gobierno de herramientas, evaluaciones, versiones de instrucciones, incidentes de IA y observabilidad.' WHERE "code" = 'ai_governance';
UPDATE "modules" SET "name" = 'Registro de viajeros (España)', "description" = 'Registro de viajeros, partes de entrada, envíos a SES.Hospedajes, ficheros por lotes, firmas, conservación y minimización de datos conforme al RGPD para el alojamiento en España.' WHERE "code" = 'spain_guest_register_compliance';
UPDATE "modules" SET "name" = 'Migración asistida por IA', "description" = 'Puesta en marcha asistida por IA, migración desde otro PMS, mapeo de la propiedad, importación de datos, validación, simulación y preparación para la salida en vivo.' WHERE "code" = 'ai_onboarding_migration';

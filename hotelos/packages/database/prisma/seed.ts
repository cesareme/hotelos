import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/password.js";
// Relative import (tsx strips the type-only deps of registry.ts at runtime):
// keeps the AI tool registry in sync with the canonical code catalog on seed.
import { TOOL_DEFINITIONS } from "../../ai-tools/src/registry.js";

const prisma = new PrismaClient();

const DEMO_PERMISSIONS = [
  "backoffice.access",
  "configuration.read",
  "configuration.manage",
  "categories.read",
  "categories.manage",
  "custom_fields.read",
  "custom_fields.manage",
  "property_profile.edit",
  "property.configure",
  "property.map.read",
  "room_types.manage",
  "rooms.manage",
  "spaces.manage",
  "departments.manage",
  "operations_setup.manage",
  "revenue_setup.manage",
  "compliance_setup.manage",
  "ai_category_setup.use",
  "pms.reservation.read",
  "pms.reservation.create",
  "pms.reservation.update",
  "pms.reservation.cancel",
  "pms.reservation.check_in",
  "pms.reservation.check_out",
  "guests.read",
  "guests.manage",
  "housekeeping.task.manage",
  "maintenance.workorder.manage",
  "billing.compliance.view",
  "invoice.issue",
  "accounting.journal.post",
  "compliance.ses.submit",
  "compliance.ses.export",
  "compliance.ses.configure",
  "compliance.gdpr.manage",
  "guest_register.read",
  "guest_register.create",
  "guest_register.edit",
  "guest_register.sign",
  "guest_register.submit",
  "guest_register.configure",
  "guest_register.export",
  "modules.read",
  "modules.enable",
  "modules.configure",
  "integrations.read",
  "integrations.connect",
  "assets.read",
  "owner.dashboard.read",
  "revenue.read",
  "revenue.forecast.read",
  "revenue.recommend",
  "revenue.manage_rates",
  "revenue.manage_restrictions",
  "revenue.apply_recommendations",
  "revenue.history_forecast.read",
  "revenue.history_forecast.export",
  "channel_manager.read",
  "channel_manager.manage",
  "channel_manager.sync",
  "channel_manager.mappings.manage",
  "channel_manager.parity.read",
  "payroll.manage",
  "banking.reconcile",
  "notifications.manage",
  "guest_experience.inbox.read",
  "ai.tool.execute",
  "ai_governance.read",
  "onboarding.read",
  "onboarding.create",
  "onboarding.upload",
  "onboarding.ai_extract",
  "onboarding.ai_map",
  "onboarding.review",
  "onboarding.apply",
  "onboarding.go_live",
  "audit.read",
  "users.read"
];

async function main() {
  await prisma.organization.upsert({
    where: { id: "org_123" },
    update: {},
    create: {
      id: "org_123",
      name: "HotelOS Demo Group",
      legalName: "HotelOS Demo SL",
      taxId: "B12345678",
      country: "ES"
    }
  });

  await prisma.property.upsert({
    where: { id: "prop_123" },
    update: {},
    create: {
      id: "prop_123",
      organizationId: "org_123",
      name: "Anfitorio Madrid Centro",
      legalName: "Anfitorio Madrid Centro SL",
      country: "ES",
      taxRegion: "Madrid",
      timezone: "Europe/Madrid",
      sesHospedajesEnabled: true,
      verifactuEnabled: true
    }
  });

  const passwordHash = hashPassword("hotelos-demo");

  await prisma.user.upsert({
    where: { email: "reception@example.com" },
    update: { passwordHash },
    create: {
      id: "usr_123",
      organizationId: "org_123",
      email: "reception@example.com",
      phone: "+34910000000",
      fullName: "Reception Demo",
      status: "active",
      mfaEnabled: true,
      passwordHash
    }
  });

  for (const key of DEMO_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key }
    });
  }

  await prisma.role.upsert({
    where: { organizationId_name: { organizationId: "org_123", name: "Local Super Admin" } },
    update: {},
    create: { id: "role_local_super_admin", organizationId: "org_123", name: "Local Super Admin" }
  });

  const allPermissions = await prisma.permission.findMany({ where: { key: { in: DEMO_PERMISSIONS } } });
  for (const perm of allPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: "role_local_super_admin", permissionId: perm.id } },
      update: {},
      create: { roleId: "role_local_super_admin", permissionId: perm.id }
    });
  }

  await prisma.userPropertyRole.upsert({
    where: { userId_propertyId_roleId: { userId: "usr_123", propertyId: "prop_123", roleId: "role_local_super_admin" } },
    update: {},
    create: { userId: "usr_123", propertyId: "prop_123", roleId: "role_local_super_admin" }
  });

  await prisma.device.upsert({
    where: { id: "dev_demo_web" },
    update: { lastSeenAt: new Date() },
    create: {
      id: "dev_demo_web",
      userId: "usr_123",
      deviceName: "Reception Web",
      platform: "web",
      trusted: true
    }
  });

  await prisma.session.upsert({
    where: { id: "sess_demo" },
    update: { lastSeenAt: new Date() },
    create: {
      id: "sess_demo",
      userId: "usr_123",
      deviceId: "dev_demo_web",
      status: "active"
    }
  });

  // Demo Canary Islands property for IGIC testing
  await prisma.property.upsert({
    where: { id: "prop_canary" },
    update: {},
    create: {
      id: "prop_canary",
      organizationId: "org_123",
      name: "Anfitorio Tenerife Sur",
      legalName: "Anfitorio Tenerife Sur SL",
      country: "ES",
      taxRegion: "canary",
      timezone: "Atlantic/Canary",
      sesHospedajesEnabled: true,
      verifactuEnabled: true
    }
  });

  // Spanish tax catalog: mainland IVA, Canary IGIC, Ceuta/Melilla IPSI
  const taxes = [
    { code: "IVA", name: "Impuesto sobre el Valor Añadido", taxRegion: "mainland", liabilityAccountCode: "477" },
    { code: "IGIC", name: "Impuesto General Indirecto Canario", taxRegion: "canary", liabilityAccountCode: "477" },
    { code: "IPSI", name: "Impuesto sobre la Producción, los Servicios y la Importación", taxRegion: "ceuta", liabilityAccountCode: "477" },
    { code: "IPSI", name: "Impuesto sobre la Producción, los Servicios y la Importación", taxRegion: "melilla", liabilityAccountCode: "477" }
  ];
  for (const tax of taxes) {
    await prisma.tax.upsert({
      where: { organizationId_code_taxRegion: { organizationId: "org_123", code: tax.code, taxRegion: tax.taxRegion } },
      update: {},
      create: { organizationId: "org_123", ...tax, country: "ES" }
    });
  }

  // Effective tax rates per line type per region. Codes:
  //   room/breakfast → 10% IVA (mainland), 7% IGIC (canary), 4% IPSI (ceuta/melilla)
  //   minibar/parking → 21% IVA, 15% IGIC (Tipo incrementado), 8% IPSI
  //   adjustment → 0%
  const rates: Array<{ taxRegion: string; code: string; appliesTo: string; rate: number }> = [
    { taxRegion: "mainland", code: "general", appliesTo: "room", rate: 10 },
    { taxRegion: "mainland", code: "general", appliesTo: "breakfast", rate: 10 },
    { taxRegion: "mainland", code: "general", appliesTo: "parking", rate: 21 },
    { taxRegion: "mainland", code: "general", appliesTo: "minibar", rate: 21 },
    { taxRegion: "mainland", code: "zero", appliesTo: "adjustment", rate: 0 },
    { taxRegion: "canary", code: "general", appliesTo: "room", rate: 7 },
    { taxRegion: "canary", code: "general", appliesTo: "breakfast", rate: 7 },
    { taxRegion: "canary", code: "incrementado", appliesTo: "parking", rate: 15 },
    { taxRegion: "canary", code: "incrementado", appliesTo: "minibar", rate: 15 },
    { taxRegion: "canary", code: "zero", appliesTo: "adjustment", rate: 0 },
    { taxRegion: "ceuta", code: "general", appliesTo: "room", rate: 4 },
    { taxRegion: "ceuta", code: "general", appliesTo: "breakfast", rate: 4 },
    { taxRegion: "ceuta", code: "general", appliesTo: "parking", rate: 8 },
    { taxRegion: "ceuta", code: "general", appliesTo: "minibar", rate: 8 },
    { taxRegion: "melilla", code: "general", appliesTo: "room", rate: 4 },
    { taxRegion: "melilla", code: "general", appliesTo: "breakfast", rate: 4 },
    { taxRegion: "melilla", code: "general", appliesTo: "parking", rate: 8 },
    { taxRegion: "melilla", code: "general", appliesTo: "minibar", rate: 8 }
  ];
  for (const rate of rates) {
    const tax = await prisma.tax.findFirst({
      where: { organizationId: "org_123", taxRegion: rate.taxRegion }
    });
    if (!tax) continue;
    await prisma.taxRate.upsert({
      where: {
        taxId_rateCode_appliesTo_validFrom: {
          taxId: tax.id,
          rateCode: rate.code,
          appliesTo: rate.appliesTo,
          validFrom: new Date("2000-01-01")
        }
      },
      update: {},
      create: {
        taxId: tax.id,
        rateCode: rate.code,
        ratePercent: rate.rate,
        appliesTo: rate.appliesTo,
        validFrom: new Date("2000-01-01"),
        active: true
      }
    });
  }

  // Spanish PGC (Plan General de Contabilidad) chart of accounts for a hotel.
  // Covers Sprint 22 (commission), Sprint 24 (payroll), Sprint 25 (year-end close)
  // and the broader fiscal pipeline (invoicing, VAT, trial balance).
  const accounts: Array<{ code: string; name: string; accountType: string }> = [
    // Grupo 1 - Financiacion basica (equity / long-term)
    { code: "100", name: "Capital social", accountType: "equity" },
    { code: "110", name: "Reservas", accountType: "equity" },
    { code: "113", name: "Reservas voluntarias", accountType: "equity" },
    { code: "1130", name: "Reservas voluntarias detalle", accountType: "equity" },
    { code: "120", name: "Remanente", accountType: "equity" },
    { code: "121", name: "Resultados negativos ejercicios anteriores", accountType: "equity" },
    { code: "129", name: "Resultado del ejercicio", accountType: "equity" },

    // Grupo 2 - Inmovilizado
    { code: "200", name: "Investigacion", accountType: "asset" },
    { code: "201", name: "Desarrollo", accountType: "asset" },
    { code: "206", name: "Aplicaciones informaticas", accountType: "asset" },
    { code: "210", name: "Terrenos y bienes naturales", accountType: "asset" },
    { code: "211", name: "Construcciones", accountType: "asset" },
    { code: "212", name: "Instalaciones tecnicas", accountType: "asset" },
    { code: "213", name: "Maquinaria", accountType: "asset" },
    { code: "215", name: "Otras instalaciones", accountType: "asset" },
    { code: "216", name: "Mobiliario", accountType: "asset" },
    { code: "217", name: "Equipos para procesos de informacion", accountType: "asset" },
    { code: "218", name: "Elementos de transporte", accountType: "asset" },
    { code: "219", name: "Otro inmovilizado material", accountType: "asset" },
    { code: "280", name: "Amortizacion acumulada del inmovilizado intangible", accountType: "asset" },
    { code: "281", name: "Amortizacion acumulada del inmovilizado material", accountType: "asset" },
    { code: "289", name: "Amortizacion acumulada de otro inmovilizado", accountType: "asset" },

    // Grupo 4 - Acreedores y deudores
    { code: "400", name: "Proveedores", accountType: "liability" },
    { code: "401", name: "Proveedores, efectos comerciales a pagar", accountType: "liability" },
    { code: "410", name: "Acreedores por prestacion de servicios", accountType: "liability" },
    { code: "4109", name: "Acreedores varios OTA", accountType: "liability" },
    { code: "430", name: "Clientes", accountType: "asset" },
    { code: "4300", name: "Clientes (s)", accountType: "asset" },
    { code: "4310", name: "Clientes OTAs", accountType: "asset" },
    { code: "436", name: "Clientes de dudoso cobro", accountType: "asset" },
    { code: "407", name: "Anticipos a proveedores", accountType: "asset" },
    { code: "438", name: "Anticipos de clientes", accountType: "liability" },
    { code: "440", name: "Deudores varios", accountType: "asset" },
    { code: "460", name: "Anticipos de remuneraciones", accountType: "asset" },
    { code: "465", name: "Remuneraciones pendientes de pago", accountType: "liability" },
    { code: "470", name: "H.P. deudora por subvenciones concedidas", accountType: "asset" },
    { code: "472", name: "H.P. IVA soportado", accountType: "asset" },
    { code: "475", name: "H.P. acreedor por conceptos fiscales", accountType: "liability" },
    { code: "4751", name: "H.P. acreedora por retenciones IRPF", accountType: "liability" },
    { code: "4752", name: "H.P. acreedora por IVA", accountType: "liability" },
    { code: "4759", name: "Tasa turistica por pagar", accountType: "liability" },
    { code: "476", name: "Organismos de la Seguridad Social acreedores", accountType: "liability" },
    { code: "477", name: "H.P. IVA repercutido", accountType: "liability" },

    // Grupo 5 - Cuentas financieras
    { code: "520", name: "Deudas a corto plazo con entidades de credito", accountType: "liability" },
    { code: "523", name: "Proveedores de inmovilizado a corto plazo", accountType: "liability" },
    { code: "544", name: "Creditos a corto plazo al personal", accountType: "asset" },
    { code: "550", name: "Cuenta corriente con socios y administradores", accountType: "liability" },
    { code: "570", name: "Caja, euros", accountType: "asset" },
    { code: "572", name: "Bancos e instituciones de credito", accountType: "asset" },
    { code: "574", name: "Inversiones financieras temporales", accountType: "asset" },

    // Grupo 6 - Compras y gastos
    { code: "600", name: "Compras de mercaderias", accountType: "expense" },
    { code: "601", name: "Compras de materias primas", accountType: "expense" },
    { code: "602", name: "Compras de otros aprovisionamientos", accountType: "expense" },
    { code: "621", name: "Arrendamientos y canones", accountType: "expense" },
    { code: "622", name: "Reparaciones y conservacion", accountType: "expense" },
    { code: "623", name: "Servicios de profesionales independientes", accountType: "expense" },
    { code: "6230", name: "Comisiones (OTAs / agencias)", accountType: "expense" },
    { code: "624", name: "Transportes", accountType: "expense" },
    { code: "625", name: "Primas de seguros", accountType: "expense" },
    { code: "626", name: "Servicios bancarios y similares", accountType: "expense" },
    { code: "627", name: "Publicidad, propaganda y relaciones publicas", accountType: "expense" },
    { code: "628", name: "Suministros", accountType: "expense" },
    { code: "629", name: "Otros servicios", accountType: "expense" },
    { code: "631", name: "Otros tributos (IBI / IAE)", accountType: "expense" },
    { code: "640", name: "Sueldos y salarios", accountType: "expense" },
    { code: "641", name: "Indemnizaciones", accountType: "expense" },
    { code: "642", name: "Seguridad Social a cargo de la empresa", accountType: "expense" },
    { code: "649", name: "Otros gastos sociales", accountType: "expense" },
    { code: "680", name: "Amortizacion del inmovilizado intangible", accountType: "expense" },
    { code: "681", name: "Amortizacion del inmovilizado material", accountType: "expense" },
    { code: "689", name: "Amortizacion de otros activos", accountType: "expense" },

    // Grupo 7 - Ventas e ingresos
    { code: "700", name: "Ventas de mercaderias", accountType: "revenue" },
    { code: "705", name: "Prestaciones de servicios (alojamiento)", accountType: "revenue" },
    { code: "7050", name: "Otros servicios (Parking, Spa)", accountType: "revenue" },
    { code: "706", name: "Descuentos sobre ventas por pronto pago", accountType: "revenue" },
    { code: "708", name: "Devoluciones de ventas y operaciones similares", accountType: "revenue" },
    { code: "709", name: "Rappels sobre ventas", accountType: "revenue" },
    { code: "7090", name: "Descuentos y ajustes sobre ventas", accountType: "revenue" }
  ];

  let accountsCreated = 0;
  let accountsExisting = 0;
  for (const acc of accounts) {
    const existing = await prisma.account.findUnique({
      where: { organizationId_code: { organizationId: "org_123", code: acc.code } }
    });
    if (existing) {
      accountsExisting += 1;
    } else {
      accountsCreated += 1;
    }
    await prisma.account.upsert({
      where: { organizationId_code: { organizationId: "org_123", code: acc.code } },
      update: { name: acc.name, accountType: acc.accountType },
      create: { organizationId: "org_123", code: acc.code, name: acc.name, accountType: acc.accountType }
    });
  }
  console.log(
    `[seed] Chart of accounts ready: ${accounts.length} accounts seeded/refreshed (${accountsCreated} new, ${accountsExisting} existing).`
  );

  // Fase 0 (Opción A): estructura de propiedad en Prisma. Antes solo vivía en el
  // seed in-memory de demoStore, por lo que getPropertyMap (ahora Prisma-only para
  // buildings/floors/zones/spaces) mostraba el mapa vacío. Estos upsert por id fijo
  // replican apps/api/src/lib/demo-store.ts y son idempotentes.
  await prisma.building.upsert({
    where: { id: "bld_main" },
    update: {},
    create: {
      id: "bld_main",
      propertyId: "prop_123",
      name: "Main Building",
      code: "MAIN",
      description: "Primary guest room building.",
      sortOrder: 1,
      active: true
    }
  });

  await prisma.floor.upsert({
    where: { id: "floor_4" },
    update: {},
    create: { id: "floor_4", propertyId: "prop_123", buildingId: "bld_main", name: "Floor 4", floorNumber: 4, code: "F4", sortOrder: 4, active: true }
  });
  await prisma.floor.upsert({
    where: { id: "floor_1" },
    update: {},
    create: { id: "floor_1", propertyId: "prop_123", buildingId: "bld_main", name: "Floor 1", floorNumber: 1, code: "F1", sortOrder: 1, active: true }
  });

  await prisma.propertyZone.upsert({
    where: { id: "zone_f4_east" },
    update: {},
    create: { id: "zone_f4_east", propertyId: "prop_123", buildingId: "bld_main", floorId: "floor_4", name: "East Wing", code: "F4E", zoneType: "guest_rooms", sortOrder: 1, active: true }
  });
  await prisma.propertyZone.upsert({
    where: { id: "zone_lobby" },
    update: {},
    create: { id: "zone_lobby", propertyId: "prop_123", buildingId: "bld_main", floorId: "floor_1", name: "Lobby", code: "LOB", zoneType: "public_area", sortOrder: 1, active: true }
  });

  await prisma.propertySpace.upsert({
    where: { id: "space_reception" },
    update: {},
    create: { id: "space_reception", propertyId: "prop_123", buildingId: "bld_main", floorId: "floor_1", zoneId: "zone_lobby", name: "Reception", code: "REC", spaceType: "reception", active: true }
  });

  await prisma.roomType.upsert({
    where: { propertyId_code: { propertyId: "prop_123", code: "DBL" } },
    update: {},
    create: {
      id: "rt_double",
      propertyId: "prop_123",
      name: "Double",
      code: "DBL",
      maxOccupancy: 2,
      baseCapacity: 2,
      description: "Standard double room"
    }
  });

  // Fase 0 (Opción A): las habitaciones sembradas ahora llevan building/floor/zone y
  // los campos de detalle (roomCode, displayName, occupancy, JSONs) para que el mapa
  // Prisma-only reproduzca el árbol anidado que antes daba el seed in-memory.
  await prisma.room.upsert({
    where: { id: "room_432" },
    update: {},
    create: {
      id: "room_432",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      buildingId: "bld_main",
      floorId: "floor_4",
      zoneId: "zone_f4_east",
      number: "432",
      floor: "4",
      roomCode: "RM432",
      displayName: "Room 432",
      maxOccupancy: 2,
      standardOccupancy: 2,
      bedConfigurationJson: { queen: 1 },
      featuresJson: { city_view: true, minibar: true },
      viewType: "city_view",
      squareMeters: 22,
      status: "inspected",
      housekeepingStatus: "inspected",
      maintenanceStatus: "ok",
      sellable: true,
      sortOrder: 432
    }
  });

  await prisma.room.upsert({
    where: { id: "room_108" },
    update: {},
    create: {
      id: "room_108",
      propertyId: "prop_123",
      roomTypeId: "rt_double",
      buildingId: "bld_main",
      floorId: "floor_1",
      number: "108",
      floor: "1",
      roomCode: "RM108",
      displayName: "Room 108",
      maxOccupancy: 2,
      standardOccupancy: 2,
      bedConfigurationJson: { queen: 1 },
      status: "out_of_order",
      housekeepingStatus: "dirty",
      maintenanceStatus: "blocked",
      sellable: false,
      sortOrder: 108
    }
  });

  await prisma.guest.upsert({
    where: { id: "guest_maria" },
    update: {},
    create: {
      id: "guest_maria",
      organizationId: "org_123",
      firstName: "Maria",
      surname1: "Lopez",
      surname2: "Garcia",
      documentType: "DNI",
      documentNumber: "12345678X",
      nationality: "ES",
      dateOfBirth: new Date("1986-04-18")
    }
  });

  await prisma.reservation.upsert({
    where: { id: "res_18392" },
    update: {},
    create: {
      id: "res_18392",
      propertyId: "prop_123",
      code: "RES-18392",
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date("2026-05-14"),
      departureDate: new Date("2026-05-16"),
      adults: 1,
      children: 0,
      roomTypeId: "rt_double",
      assignedRoomId: "room_432",
      totalAmount: 272,
      currency: "EUR"
    }
  });

  await prisma.reservationGuest.upsert({
    where: { id: "rg_maria_18392" },
    update: {},
    create: {
      id: "rg_maria_18392",
      reservationId: "res_18392",
      guestId: "guest_maria",
      isPrimary: true
    }
  });

  await prisma.folio.upsert({
    where: { id: "folio_18392" },
    update: {},
    create: {
      id: "folio_18392",
      reservationId: "res_18392",
      guestId: "guest_maria",
      status: "open",
      currency: "EUR"
    }
  });

  await prisma.folioLine.upsert({
    where: { id: "fl_room_18392" },
    update: {},
    create: {
      id: "fl_room_18392",
      folioId: "folio_18392",
      type: "room",
      description: "Room charge",
      quantity: 2,
      unitPrice: 136,
      taxCode: "ES_IVA_10",
      total: 272,
      postedBy: "system"
    }
  });

  await prisma.payment.upsert({
    where: { id: "pay_18392" },
    update: {},
    create: {
      id: "pay_18392",
      propertyId: "prop_123",
      folioId: "folio_18392",
      amount: 272,
      currency: "EUR",
      method: "card",
      pspReference: "psp_demo_18392",
      status: "captured"
    }
  });

  await prisma.housekeepingTask.upsert({
    where: { id: "hkt_arrival_432" },
    update: {},
    create: {
      id: "hkt_arrival_432",
      propertyId: "prop_123",
      roomId: "room_432",
      taskType: "inspection",
      priority: "normal",
      status: "done",
      assignedTo: "usr_housekeeping_demo",
      dueAt: new Date("2026-05-14T12:00:00.000Z")
    }
  });

  await prisma.workOrder.upsert({
    where: { id: "wo_108_leak" },
    update: {},
    create: {
      id: "wo_108_leak",
      propertyId: "prop_123",
      roomId: "room_108",
      title: "Bathroom leak",
      description: "Guest reported water under sink.",
      priority: "urgent",
      status: "open",
      blocksRoom: true,
      createdBy: "usr_123"
    }
  });

  await prisma.asset.upsert({
    where: { id: "asset_hvac_432" },
    update: {},
    create: {
      id: "asset_hvac_432",
      propertyId: "prop_123",
      roomId: "room_432",
      assetType: "hvac",
      name: "Room 432 HVAC",
      serialNumber: "HVAC-432-2022",
      warrantyUntil: new Date("2027-06-30"),
      status: "needs_attention"
    }
  });

  await prisma.conversation.upsert({
    where: { id: "conv_maria" },
    update: {},
    create: {
      id: "conv_maria",
      propertyId: "prop_123",
      guestId: "guest_maria",
      reservationId: "res_18392",
      channel: "app",
      status: "open",
      aiEnabled: true
    }
  });

  await prisma.message.upsert({
    where: { id: "msg_maria_parking" },
    update: {},
    create: {
      id: "msg_maria_parking",
      conversationId: "conv_maria",
      senderType: "guest",
      body: "Do you have parking?",
      language: "en"
    }
  });

  // Notification templates (Sprint 26 engine). Org-scoped defaults
  // (propertyId = null) that the dispatcher resolves with property→org
  // fallback. Seeded idempotently by the natural key
  // (organizationId, propertyId, code, channel, language). We use
  // findFirst → create/update rather than prisma.upsert because the compound
  // unique helper does not accept a null propertyId (see templates.service.ts).
  const notificationTemplates: Array<{
    code: string;
    channel: string;
    language: string;
    subject: string;
    body: string;
  }> = [
    {
      // Sprint 45 — magic-link email for guest portal sign-in.
      code: "guest_magic_link",
      channel: "email",
      language: "es",
      subject: "Tu acceso al portal de huésped — {{propertyName}}",
      body: [
        "Hola,",
        "",
        "Has solicitado acceder al portal de huésped de {{propertyName}}.",
        "Pulsa el siguiente enlace para entrar de forma segura:",
        "",
        "{{magicLinkUrl}}",
        "",
        "Este enlace es de un solo uso y caduca en {{expiryHours}} horas.",
        "Si el enlace no funciona, también puedes iniciar sesión con tu",
        "código de reserva: {{reservationCode}}",
        "",
        "Si no has solicitado este acceso, puedes ignorar este correo.",
        "",
        "— Equipo de {{propertyName}}",
        "",
        "----------------------------------------------------------------",
        "",
        "Hello,",
        "",
        "You requested access to the {{propertyName}} guest portal.",
        "Use the link below to sign in securely:",
        "",
        "{{magicLinkUrl}}",
        "",
        "This is a single-use link and it expires in {{expiryHours}} hours.",
        "If the link does not work, you can also sign in with your",
        "reservation code: {{reservationCode}}",
        "",
        "If you did not request this, you can safely ignore this email.",
        "",
        "— The {{propertyName}} team"
      ].join("\n")
    }
  ];

  let templatesCreated = 0;
  let templatesUpdated = 0;
  for (const tpl of notificationTemplates) {
    const existing = await prisma.notificationTemplate.findFirst({
      where: {
        organizationId: "org_123",
        propertyId: null,
        code: tpl.code,
        channel: tpl.channel,
        language: tpl.language
      }
    });
    if (existing) {
      await prisma.notificationTemplate.update({
        where: { id: existing.id },
        data: { subject: tpl.subject, body: tpl.body, active: true }
      });
      templatesUpdated += 1;
    } else {
      await prisma.notificationTemplate.create({
        data: {
          organizationId: "org_123",
          propertyId: null,
          code: tpl.code,
          channel: tpl.channel,
          language: tpl.language,
          subject: tpl.subject,
          body: tpl.body,
          active: true
        }
      });
      templatesCreated += 1;
    }
  }
  console.log(
    `[seed] Notification templates ready: ${notificationTemplates.length} total (${templatesCreated} new, ${templatesUpdated} refreshed).`
  );

  // ---- Sprint 50 — AI Human Review Queue (HITL) demo items ----
  // Idempotent: fixed ids + upsert. createdAt is set relative to "now" on every
  // run so the SLA-breach (> 60 min pending) and age columns stay meaningful.
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
  const reviewItems: Array<{
    id: string;
    reviewType: string;
    relatedEntityType: string;
    relatedEntityId: string;
    status: string;
    assignedTo: string | null;
    minutesAgo: number;
    payloadJson: Record<string, unknown>;
  }> = [
    {
      id: "rev_rate_001",
      reviewType: "rate_recommendation",
      relatedEntityType: "rate_plan",
      relatedEntityId: "rate_bar_double",
      status: "pending",
      assignedTo: null,
      minutesAgo: 142, // breached (> 60 min)
      payloadJson: {
        summary: "AI suggests raising BAR Double by 18% for the weekend on high demand.",
        currentRate: 120,
        suggestedRate: 142,
        confidence: 0.61,
        riskLevel: "high"
      }
    },
    {
      id: "rev_invoice_002",
      reviewType: "invoice_issue",
      relatedEntityType: "invoice",
      relatedEntityId: "inv_2026_0481",
      status: "pending",
      assignedTo: "usr_123",
      minutesAgo: 24, // within SLA
      payloadJson: {
        summary: "AI flagged a possible duplicate invoice for the same reservation.",
        invoiceTotal: 432.5,
        suspectedDuplicateOf: "inv_2026_0477",
        confidence: 0.48
      }
    },
    {
      id: "rev_register_003",
      reviewType: "guest_register_submit",
      relatedEntityType: "guest_register_entry",
      relatedEntityId: "greg_88213",
      status: "pending",
      assignedTo: null,
      minutesAgo: 8,
      payloadJson: {
        summary: "Low-confidence OCR on guest ID document before SES submission.",
        documentType: "passport",
        ocrConfidence: 0.39,
        riskLevel: "high"
      }
    },
    {
      id: "rev_review_004",
      reviewType: "review_response",
      relatedEntityType: "guest_review",
      relatedEntityId: "grev_5521",
      status: "approved",
      assignedTo: "usr_123",
      minutesAgo: 180,
      payloadJson: {
        summary: "AI-drafted reply to a 2-star Booking.com review.",
        draftReply: "Thank you for your feedback — we are sorry your stay fell short...",
        _review: {
          decidedBy: "usr_123",
          decidedAt: minutesAgo(95).toISOString(),
          notes: "Tone OK, posted.",
          history: [
            { action: "approved", userId: "usr_123", at: minutesAgo(95).toISOString(), detail: "Tone OK, posted." }
          ]
        }
      }
    },
    {
      id: "rev_rate_005",
      reviewType: "rate_recommendation",
      relatedEntityType: "rate_plan",
      relatedEntityId: "rate_bar_suite",
      status: "escalated",
      assignedTo: "usr_123",
      minutesAgo: 320,
      payloadJson: {
        summary: "AI suggests dropping Suite rate 25% during a competitor event — escalated to revenue manager.",
        currentRate: 280,
        suggestedRate: 210,
        confidence: 0.55,
        _review: {
          escalatedTo: "revenue_manager",
          history: [
            { action: "escalated", userId: "usr_123", at: minutesAgo(120).toISOString(), detail: "revenue_manager" }
          ]
        }
      }
    },
    {
      id: "rev_invoice_006",
      reviewType: "invoice_issue",
      relatedEntityType: "invoice",
      relatedEntityId: "inv_2026_0455",
      status: "rejected",
      assignedTo: "usr_123",
      minutesAgo: 240,
      payloadJson: {
        summary: "AI proposed auto-voiding an invoice flagged as fraudulent.",
        invoiceTotal: 1290.0,
        _review: {
          decidedBy: "usr_123",
          decidedAt: minutesAgo(150).toISOString(),
          reason: "Not fraudulent — corporate booking confirmed by phone.",
          history: [
            {
              action: "rejected",
              userId: "usr_123",
              at: minutesAgo(150).toISOString(),
              detail: "Not fraudulent — corporate booking confirmed by phone."
            }
          ]
        }
      }
    }
  ];

  for (const item of reviewItems) {
    const data = {
      organizationId: "org_123",
      propertyId: "prop_123",
      reviewType: item.reviewType,
      relatedEntityType: item.relatedEntityType,
      relatedEntityId: item.relatedEntityId,
      payloadJson: item.payloadJson as object,
      status: item.status,
      assignedTo: item.assignedTo,
      createdAt: minutesAgo(item.minutesAgo)
    };
    await prisma.aiHumanReviewItem.upsert({
      where: { id: item.id },
      update: data,
      create: { id: item.id, ...data }
    });
  }
  console.log(`[seed] AI human review items ready: ${reviewItems.length} demo items.`);

  // ---- Sprint 48 — AI Pipeline Status (tool-call telemetry) demo data ----
  // Seeds a small tool registry (for moduleCode resolution), ~40 AiToolCall
  // rows spread over the last 14 days, and a couple of anomaly events so the
  // pipeline dashboard isn't all zeros. Idempotent: skipped once any tool
  // calls exist for the org.
  const existingToolCalls = await prisma.aiToolCall.count({ where: { organizationId: "org_123" } });
  if (existingToolCalls === 0) {
    const toolRegistry: Array<{ toolName: string; moduleCode: string; riskLevel: string }> = [
      { toolName: "checkInReservation", moduleCode: "pms", riskLevel: "high" },
      { toolName: "draftGuestReply", moduleCode: "guest_experience", riskLevel: "medium" },
      { toolName: "recommendRate", moduleCode: "revenue", riskLevel: "medium" },
      { toolName: "classifyDocument", moduleCode: "onboarding", riskLevel: "low" },
      { toolName: "summarizeReview", moduleCode: "reputation", riskLevel: "low" },
      { toolName: "matchBankTransaction", moduleCode: "banking", riskLevel: "medium" }
    ];
    for (const t of toolRegistry) {
      await prisma.aiToolRegistry.upsert({
        where: { toolName: t.toolName },
        update: { moduleCode: t.moduleCode, riskLevel: t.riskLevel, active: true },
        create: { toolName: t.toolName, moduleCode: t.moduleCode, riskLevel: t.riskLevel, active: true }
      });
    }

    const aiStatuses = ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "awaiting_confirmation", "pending", "rejected"];
    const aiModels = ["claude-3-5-sonnet", "claude-3-haiku", "claude-3-opus"];
    const aiAutomationLevels = ["auto", "assisted", "manual_confirm"];
    const aiToolNames = toolRegistry.map((t) => t.toolName);
    const AI_DEMO_COUNT = 44;
    const aiCallData: Array<Parameters<typeof prisma.aiToolCall.createMany>[0]["data"]> = [] as never;
    for (let i = 0; i < AI_DEMO_COUNT; i += 1) {
      // Spread across the last 14 days with varied intra-day times.
      const dayOffset = i % 14;
      const createdAt = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000 - (i % 9) * 47 * 60 * 1000);
      const toolName = aiToolNames[i % aiToolNames.length];
      const status = aiStatuses[i % aiStatuses.length];
      const isError = status === "failed" || status === "rejected";
      const confidence = Number((0.45 + ((i * 13) % 55) / 100).toFixed(4)); // 0.45–0.99
      const latencyMs = 180 + ((i * 137) % 2400);
      const tokensInput = 200 + ((i * 53) % 1800);
      const tokensOutput = 80 + ((i * 31) % 900);
      const costEur = Number(((tokensInput * 0.000003) + (tokensOutput * 0.000015)).toFixed(6));
      (aiCallData as unknown[]).push({
        organizationId: "org_123",
        propertyId: i % 5 === 0 ? null : "prop_123",
        userId: "usr_123",
        conversationId: i % 3 === 0 ? `conv_demo_${i % 7}` : null,
        toolName,
        inputJson: { demo: true, index: i, args: { sample: `payload-${i}` } },
        outputJson: isError ? null : { ok: true, result: `result-${i}`, summary: `Demo output for ${toolName}` },
        confidence,
        requiredConfirmation: status === "awaiting_confirmation",
        confirmedBy: status === "succeeded" && i % 4 === 0 ? "usr_123" : null,
        status,
        model: aiModels[i % aiModels.length],
        latencyMs,
        tokensInput,
        tokensOutput,
        costEur,
        errorMessage: isError ? `Demo ${status} error on ${toolName}` : null,
        automationLevel: aiAutomationLevels[i % aiAutomationLevels.length],
        createdAt
      });
    }
    await prisma.aiToolCall.createMany({ data: aiCallData as never });

    await prisma.anomalyEvent.createMany({
      data: [
        {
          organizationId: "org_123",
          propertyId: "prop_123",
          anomalyType: "latency_spike",
          metricCode: "ai_tool_latency",
          severity: "high",
          title: "AI tool latency spike",
          description: "Average tool latency exceeded 2x baseline for recommendRate.",
          status: "open"
        },
        {
          organizationId: "org_123",
          propertyId: null,
          anomalyType: "failure_rate",
          metricCode: "ai_tool_failure_rate",
          severity: "medium",
          title: "Elevated failure rate",
          description: "checkInReservation failure rate above 10% in the last 24h.",
          status: "investigating"
        }
      ]
    });
    console.log(`[seed] AI pipeline demo data ready: ${AI_DEMO_COUNT} tool calls, ${toolRegistry.length} registry tools, 2 anomalies.`);
  } else {
    console.log(`[seed] AI pipeline demo data skipped: ${existingToolCalls} tool call(s) already present.`);
  }

  // ---- Sprint 49 — AI Governance (policies + prompts + evals + incidents) ----
  // Idempotent: org-level policies upserted by (org, policyCode); prompt versions and
  // evaluations created only when absent; incidents seeded once.

  // 5 default policies (org-scoped, propertyId = null) with sensible defaults.
  const defaultPolicies: Array<{ policyCode: string; name: string; configuration: Record<string, unknown> }> = [
    { policyCode: "max_autonomous_risk", name: "Nivel máximo de riesgo autónomo", configuration: { maxLevel: "medium" } },
    { policyCode: "require_confirmation_above_confidence", name: "Requerir confirmación por encima del umbral de confianza", configuration: { threshold: 0.85 } },
    { policyCode: "pii_redaction", name: "Ocultación de datos personales (PII)", configuration: { enabled: true } },
    { policyCode: "guest_disclosure_required", name: "Aviso de IA al huésped obligatorio", configuration: { enabled: true } },
    { policyCode: "human_review_for_high_risk", name: "Revisión humana para acciones de alto riesgo", configuration: { enabled: true } }
  ];
  let policiesCreated = 0;
  for (const p of defaultPolicies) {
    const existing = await prisma.aiPolicy.findFirst({
      where: { organizationId: "org_123", propertyId: null, policyCode: p.policyCode }
    });
    if (existing) {
      await prisma.aiPolicy.update({
        where: { id: existing.id },
        data: { name: p.name, configurationJson: p.configuration as object }
      });
    } else {
      await prisma.aiPolicy.create({
        data: {
          organizationId: "org_123",
          propertyId: null,
          policyCode: p.policyCode,
          name: p.name,
          configurationJson: p.configuration as object,
          active: true
        }
      });
      policiesCreated += 1;
    }
  }
  console.log(`[seed] AI policies ready: ${defaultPolicies.length} default policies (${policiesCreated} new).`);

  // Demo prompt versions: one prompt code with v1 archived + v2 published, plus a draft.
  const promptCode = "guest_message_reply";
  const existingPrompts = await prisma.aiPromptVersion.count({ where: { promptCode } });
  if (existingPrompts === 0) {
    await prisma.aiPromptVersion.create({
      data: {
        promptCode,
        version: "v1",
        content: [
          "You are a hotel front-desk assistant.",
          "Reply to the guest politely and concisely.",
          "Always thank the guest for reaching out."
        ].join("\n"),
        status: "archived",
        notes: "Initial draft.",
        createdBy: "usr_123",
        archivedAt: new Date()
      }
    });
    await prisma.aiPromptVersion.create({
      data: {
        promptCode,
        version: "v2",
        content: [
          "You are a hotel front-desk assistant for {{propertyName}}.",
          "Reply to the guest politely, warmly and concisely.",
          "Always thank the guest for reaching out.",
          "Never disclose internal pricing logic or other guests' data."
        ].join("\n"),
        status: "published",
        notes: "Added property name + privacy guardrail.",
        createdBy: "usr_123",
        publishedAt: new Date()
      }
    });
    await prisma.aiPromptVersion.create({
      data: {
        promptCode,
        version: "v3",
        content: [
          "You are a hotel front-desk assistant for {{propertyName}}.",
          "Reply to the guest politely, warmly and concisely.",
          "Offer one relevant upsell when appropriate.",
          "Always thank the guest for reaching out.",
          "Never disclose internal pricing logic or other guests' data."
        ].join("\n"),
        status: "draft",
        notes: "Experimenting with an upsell line.",
        createdBy: "usr_123"
      }
    });
    console.log(`[seed] AI prompt versions ready: 3 versions for ${promptCode} (v2 published).`);
  } else {
    console.log(`[seed] AI prompt versions skipped: ${existingPrompts} version(s) already present for ${promptCode}.`);
  }

  // Demo evaluations.
  const existingEvals = await prisma.aiEvaluation.count({ where: { organizationId: "org_123" } });
  if (existingEvals === 0) {
    await prisma.aiEvaluation.create({
      data: {
        organizationId: "org_123",
        propertyId: "prop_123",
        evaluationName: "Guest reply tone & safety",
        evaluationType: "quality",
        promptCode,
        status: "pending"
      }
    });
    await prisma.aiEvaluation.create({
      data: {
        organizationId: "org_123",
        propertyId: null,
        evaluationName: "Rate recommendation accuracy",
        evaluationType: "accuracy",
        promptCode: null,
        status: "completed",
        score: 87.5,
        passRate: 92.0,
        sampleSize: 24,
        resultsJson: {
          simulated: true,
          note: "Pre-seeded completed eval for the dashboard.",
          summary: { sampleSize: 24, passCount: 22, failCount: 2, score: 87.5, passRate: 92.0 }
        },
        completedAt: new Date()
      }
    });
    console.log(`[seed] AI evaluations ready: 2 demo evaluations (1 pending, 1 completed).`);
  } else {
    console.log(`[seed] AI evaluations skipped: ${existingEvals} evaluation(s) already present.`);
  }

  // Demo incidents.
  const existingIncidents = await prisma.aiIncident.count({ where: { organizationId: "org_123" } });
  if (existingIncidents === 0) {
    await prisma.aiIncident.create({
      data: {
        organizationId: "org_123",
        propertyId: "prop_123",
        incidentType: "hallucination",
        severity: "high",
        title: "AI quoted a non-existent room amenity",
        description: "Guest reply claimed a rooftop pool that the property does not have.",
        status: "open"
      }
    });
    await prisma.aiIncident.create({
      data: {
        organizationId: "org_123",
        propertyId: null,
        incidentType: "policy_violation",
        severity: "medium",
        title: "Autonomous refund above approved threshold",
        description: "A refund tool executed autonomously above the configured ceiling.",
        status: "investigating",
        assignedTo: "usr_123"
      }
    });
    console.log(`[seed] AI incidents ready: 2 demo incidents (1 open, 1 investigating).`);
  } else {
    console.log(`[seed] AI incidents skipped: ${existingIncidents} incident(s) already present.`);
  }

  // ---- Sprint 51 — Property AI settings (per-property master switch + defaults) ----
  // Idempotent: upsert by the unique propertyId.
  const flagshipDisclosure =
    "Parte de la atención de este establecimiento puede estar gestionada por un asistente de inteligencia artificial. " +
    "Puede solicitar hablar con una persona del equipo en cualquier momento.\n" +
    "Some interactions at this property may be handled by an AI assistant. " +
    "You can ask to speak with a member of our team at any time.";
  await prisma.propertyAiSetting.upsert({
    where: { propertyId: "prop_123" },
    update: {},
    create: {
      propertyId: "prop_123",
      aiEnabled: true,
      defaultAutomationLevel: "suggest_and_confirm",
      guestFacingDisclosure: flagshipDisclosure,
      voiceLocales: ["es-ES", "en-GB"],
      configurationJson: {}
    }
  });
  console.log("[seed] Property AI settings ready: prop_123 (enabled, suggest_and_confirm, es-ES/en-GB).");

  // ---- Sprint 47 — AI Tool Registry ----
  // Idempotent: upsert every code-defined tool by its unique toolName, and
  // deactivate (never delete) any registry row no longer present in code.
  const codeToolNames = new Set<string>();
  for (const tool of TOOL_DEFINITIONS) {
    codeToolNames.add(tool.name as string);
    await prisma.aiToolRegistry.upsert({
      where: { toolName: tool.name as string },
      create: {
        toolName: tool.name as string,
        moduleCode: tool.moduleCode,
        riskLevel: tool.riskLevel,
        requiresConfirmation: tool.requiresConfirmation,
        active: true
      },
      update: {
        moduleCode: tool.moduleCode,
        riskLevel: tool.riskLevel,
        requiresConfirmation: tool.requiresConfirmation,
        active: true
      }
    });
  }
  const orphanRegistryTools = await prisma.aiToolRegistry.findMany({
    where: { active: true, toolName: { notIn: Array.from(codeToolNames) } },
    select: { toolName: true }
  });
  let deactivatedTools = 0;
  if (orphanRegistryTools.length > 0) {
    const result = await prisma.aiToolRegistry.updateMany({
      where: { toolName: { in: orphanRegistryTools.map((t) => t.toolName) } },
      data: { active: false }
    });
    deactivatedTools = result.count;
  }
  console.log(
    `[seed] AI tool registry ready: ${codeToolNames.size} tools synced from code (${deactivatedTools} deactivated).`
  );

  await prisma.auditEvent.create({
    data: {
      organizationId: "org_123",
      propertyId: "prop_123",
      actorType: "system",
      action: "DEMO_SEED_READY",
      entityType: "property",
      entityId: "prop_123",
      afterJson: {
        flagshipReservationCode: "RES-18392",
        flagshipRoomNumber: "432",
        idDocumentImagesStored: false
      },
      correlationId: "corr_demo_seed",
      hashAlgorithm: "sha256",
      currentHash: "demo_seed_ready_hash"
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

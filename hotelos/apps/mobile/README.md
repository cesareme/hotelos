# `apps/mobile` · app móvil de personal — demo interna: no publicar

Estado verificado el 2026-09-20 (Tanda L7 · lote L7-10, sin cambios de código; decisión D5 del recon L7: **congelar como
demo interna y documentar**). Expo 53 / React Native 0.79 / React 19 (`package.json`), `app.json` con `slug hotelos-mobile`
y `bundleIdentifier com.hotelos.mobile` (identificadores técnicos que no siguen a la marca, D13 del rebrand), `projectId`
de EAS `replace-with-eas-project-id`. `corepack pnpm --filter @hotelos/mobile typecheck` → 0 errores (2026-09-20).

## Qué es y qué no es

- Es una **maqueta navegable** de la suite para el personal del hotel: 110 pantallas `.tsx` en `src/screens` (más 4
  duplicados `* 2.tsx` en `src/screens/rooms/`), 9.243 líneas, cinco pestañas (`HotelOSTabs.tsx`: Hoy · Timeline · IA ·
  Operaciones · Más) y un menú «Más» con 18 entradas en cuatro grupos (`more/MoreScreen.tsx`).
- **No está conectada a ningún hotel real.** `App.tsx` no monta `AuthProvider` (`src/auth/AuthContext.tsx:42` lo define,
  nadie lo usa; `useAuth` no tiene consumidores); el inicio de sesión (`LoginScreen.tsx`) llama a `loginDemo()`
  (`services/api.ts:629-660`), que ante cualquier fallo devuelve `token: "demo.jwt.token"` y la propiedad ficticia
  `prop_123` («Hotel Demo Madrid Centro»); la cabecera pinta «Madrid Centro» fijo (`App.tsx`).
- `services/api.ts` (728 líneas, 26 `fetch` contra `http://localhost:3000` fijo, `API_URL` línea 10) lleva `prop_123` en
  16 sitios y `org_123` en 2, y **cada llamada cae en silencio a datos inventados** cuando el API no responde (por ejemplo
  el panel de Hoy devuelve «26 llegadas · 18 salidas · 12.840 € de ingresos» sin ninguna consulta). `src/api/client.ts`
  sí lee `EXPO_PUBLIC_API_BASE_URL` (línea 38) y `DEFAULT_PROPERTY_ID = "prop_123"` (`AuthContext.tsx:22`), pero solo los
  usa el `AuthProvider` sin montar. 14 pantallas importan `services/api`.
- El **check-in por IA** (`screens/ai/checkin/*`: voz → escaneo → OCR → coincidencia → validación → confirmación → firma →
  hecho) es una secuencia estática: `checkInFlowData.ts` trae un titular, un documento y una reserva **inventados**;
  `DocumentScanScreen.tsx` tiene el botón de cámara con `onPress={() => undefined}`; `GuestSignatureScreen.tsx` no captura
  ningún trazo; `AICommandCenterScreen.tsx` ejecuta `executeCheckInConfirmation` con `signatureObjectKey: "sig_mobile_demo"`
  (`services/api.ts:98`) y, si el API no responde, informa «executed». Esas ocho pantallas ni siquiera están enrutadas
  desde `App.tsx` (solo `checkInSteps` se importa para pintar la barra de pasos). Sin cámara ni NFC reales
  (`services/nativeCapabilities.ts`: puente `setNativeCapabilityBridge` sin implementación; sin él, transcripción y campos
  del documento son constantes).
- `screens/guestJourney/GuestJourneyScreen.tsx` («Guest Journey Center») muestra 13 pasos con un titular y unos estados
  fijos (líneas 5-19): no lee `GET /reservations/:id/guest-journey` ni ninguna reserva. El recorrido real del huésped
  vive en el back office web (`/recepcion/reservas/:id/recorrido`, `docs/runbooks/portal-huesped.md` §9).
- Copy mayoritariamente en inglés («Coming soon / In progress», «Mobile operating system for hotel teams», menú «Más» con
  «Finance & Compliance», «Guest Experience»…); no está en `pilots/tanda5-nav-tree.csv` ni en ninguna puerta salvo el
  typecheck y el contrato de marca (`tests/brand-contract.test.mjs` barre `App.tsx`, `app.json` y `src/**`).

## Inventario de pantallas (para quién, qué muestra hoy)

| Grupo | Pantallas (`src/screens`) | Para quién | Estado real |
|---|---|---|---|
| Hoy y planning | `today/TodayDashboardScreen` (+ `AiDailyBriefingCard`, `ChannelSyncAlertCard`, `RevenueSnapshotCard`), `rooms/MobilePlanningScreen`, `rooms/TabletPlanningScreen`, `rooms/RoomsScreen`, `rooms/RoomDetailScreen`, `timeline/LiveTimelineScreen` | recepción, pisos | maqueta con `roomPlanningData.ts` y respaldo inventado de `getDashboardSnapshot` |
| IA | `AICommandCenterScreen`, `ai/AiCommandCenterScreen`, `ai/AiConfirmationScreen`, `ai/AiActionHistoryScreen`, `ai/checkin/*` (8) | recepción | guion fijo; confirma sin firma real |
| Operaciones | `tasks/TasksHomeScreen`, `tasks/HousekeepingBoardScreen`, `tasks/MaintenanceBoardScreen`, `tasks/ComplianceInboxScreen`, `OperationsScreen`, `OfflineSyncScreen` (+ `services/offlineQueue.ts`) | pisos, mantenimiento | datos de `getOperationsSnapshot` con respaldo inventado |
| PMS y huéspedes | `PmsScreen`, `pms/ArrivalsScreen`, `pms/DeparturesScreen`, `pms/FolioScreen`, `pms/GuestProfileScreen`, `pms/ReservationDetailScreen`, `guestJourney/GuestJourneyScreen`, `concierge/GuestInboxScreen`, `concierge/ConversationDetailScreen`, `ConciergeScreen` | recepción | maqueta; el chat adjunta «fotos» ficticias |
| Cumplimiento | `guest-register/*` (7: bandeja, detalle, firma, OCR, cola SES, lote de autoridades, check-in), `ComplianceInboxScreen` | recepción, administración | maqueta |
| Finanzas | `accounting/*` (3), `invoicing/*` (2), `payments/*` (2), `AccountingScreen` | administración | maqueta |
| Revenue y canales | `revenue/*` (17), `channelManager/ChannelManagerHomeScreen` | comercial, dirección | maqueta |
| Activos y propietario | `assets/*` (3), `owner/*` (2), `AssetsScreen`, `OwnerModeScreen` | dirección, propietario | maqueta |
| Configuración y alta | `backoffice/*` (5 + 5 formularios), `settings/*` (3), `onboarding/*` (3), `PropertySelectorScreen`, `SettingsScreen`, `NotificationsScreen`, `more/*` (5), `marketplace/IntegrationMarketplaceHome`, `dev/*` (3: lanzador local con `EXPO_PUBLIC_SHOW_DEV_LAUNCHER`, depuración de módulos, destino tras el login) | dirección, sistemas | maqueta; «Abrir back office» enlaza al admin-web si hay URL |

## Qué haría falta para que dejara de ser demo (plan L7 de la Tanda 5, no ejecutado)

1. Montar `AuthProvider` en `App.tsx` y hacer el login real contra `POST /auth/login` con `EXPO_PUBLIC_API_BASE_URL`.
2. Sustituir `services/api.ts` por `src/api/endpoints.ts` (cliente con token) y quitar `prop_123` / `org_123` / los
   respaldos silenciosos: sin API la pantalla debe decirlo, no inventar cifras.
3. Elegir 5-6 pantallas útiles (Hoy, llegadas/salidas con el cajón de check-in, pisos, mantenimiento, cola de la IA) y
   retirar el resto o marcarlas «demo interna» en la propia pantalla.
4. Cámara y MRZ reales (VisionKit / ML Kit por `nativeCapabilities.ts`) para el escaneo de documentos; firma con trazo.
5. Copy en español y entrada en el CSV de navegación si el móvil entra en el producto.

Mientras tanto: **no publicar en tiendas ni enseñar como producto**; para el huésped el canal es el portal web
(`apps/guest-web`, `docs/runbooks/portal-huesped.md`) y para el personal el back office web.

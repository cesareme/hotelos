-- Tanda L7 · corrector L7-REV-01 (portal del huésped): ámbito de la sesión del portal.
-- `guest_portal_sessions.purpose` = sign_in (código + correo, 24 h) | invitation (enlace del check-in en
-- línea) | survey (enlace de la encuesta post-estancia, 30 d). Una sesión `survey` SOLO abre
-- GET|POST /guest-portal/survey; el resto del portal responde 401 GUEST_SESSION_INVALID
-- (verifyGuestToken, guest-portal-auth.service.ts). Sin índices ni enums; las filas existentes
-- quedan como `sign_in` (el enlace de la encuesta emitido antes de esta migración conserva el acceso
-- completo hasta que caduque; issueGuestPortalSession marca `survey` desde ahora).
-- Aditiva y reversible:
--   ALTER TABLE "guest_portal_sessions" DROP COLUMN "purpose";
ALTER TABLE "guest_portal_sessions"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'sign_in';

-- Tanda L7 · lote L7-04 (portal del huésped · encuesta post-estancia): política de check-in con
-- `post_stay_survey_enabled` (opt-in por propiedad; el paso del tick del check-in invita a la encuesta a las
-- reservas checked_out) y `post_stay_survey_delay_hours` (horas desde las 00:00 del día de salida; 24 = el día
-- siguiente). Sin índices ni enums; `surveys` / `survey_responses` no cambian (una respuesta por reserva se
-- garantiza en código: 409 SURVEY_ALREADY_ANSWERED).
-- Aditiva y reversible:
--   ALTER TABLE "property_checkin_policies" DROP COLUMN "post_stay_survey_enabled", DROP COLUMN "post_stay_survey_delay_hours";
ALTER TABLE "property_checkin_policies"
  ADD COLUMN "post_stay_survey_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "post_stay_survey_delay_hours" INTEGER NOT NULL DEFAULT 24;

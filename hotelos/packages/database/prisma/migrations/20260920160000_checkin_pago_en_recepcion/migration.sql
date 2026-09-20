-- Corrector Tanda CHK (hallazgo REV3-02): política de check-in con `allow_pay_at_reception`.
-- Sin PSP, `POST /guest-portal/check-in/payment-link` deja la sesión en `at_reception`; ese estado solo
-- satisface `deposit_policy` para el huésped/kiosco cuando la propiedad lo admite (por defecto NO).
-- Aditiva y reversible: ALTER TABLE "property_checkin_policies" DROP COLUMN "allow_pay_at_reception".
ALTER TABLE "property_checkin_policies" ADD COLUMN "allow_pay_at_reception" BOOLEAN NOT NULL DEFAULT false;

-- The owner's actions on a run the Fleet holds for a binding problem: let it continue once
-- (owner-override) or stop it (owner-stop). Audited with the other owner settlements.
ALTER TABLE "maintenance_recovery" DROP CONSTRAINT IF EXISTS "maintenance_recovery_targetKind_check";
ALTER TABLE "maintenance_recovery" ADD CONSTRAINT "maintenance_recovery_targetKind_check"
  CHECK ("targetKind" IN ('attempt', 'effect', 'run'));
ALTER TABLE "maintenance_recovery" DROP CONSTRAINT IF EXISTS "maintenance_recovery_basis_check";
ALTER TABLE "maintenance_recovery" ADD CONSTRAINT "maintenance_recovery_basis_check"
  CHECK ("basis" IN ('evidence', 'owner-verified', 'owner-override', 'owner-stop'));

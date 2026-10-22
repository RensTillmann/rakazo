-- A run the Fleet declared obsolete is cancelled automatically (fleet-obsolete), audited here.
ALTER TABLE "maintenance_recovery" DROP CONSTRAINT IF EXISTS "maintenance_recovery_basis_check";
ALTER TABLE "maintenance_recovery" ADD CONSTRAINT "maintenance_recovery_basis_check"
  CHECK ("basis" IN ('evidence', 'owner-verified', 'owner-override', 'owner-stop', 'owner-recheck',
    'fleet-obsolete'));

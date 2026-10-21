-- Owner settlements of unfinished operations. Provenance only: never a resume, retry or undo.
CREATE TABLE "maintenance_recovery" (
  "requestId" TEXT PRIMARY KEY,
  "operatorId" TEXT NOT NULL,
  "targetKind" TEXT NOT NULL CHECK ("targetKind" IN ('attempt', 'effect')),
  "targetId" TEXT NOT NULL,
  "basis" TEXT NOT NULL CHECK ("basis" IN ('evidence', 'owner-verified')),
  "fromStatus" TEXT NOT NULL,
  "toStatus" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "maintenance_recovery_target_idx" ON "maintenance_recovery" ("targetKind", "targetId");

-- Separate from routine, usage and deadline holds. No timer or auto-resume.
CREATE TABLE "maintenance_state" (
  "id" TEXT PRIMARY KEY CHECK ("id" = 'default'),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0)
);
INSERT INTO "maintenance_state" ("id") VALUES ('default');

CREATE TABLE "maintenance_audit" (
  "revision" INTEGER PRIMARY KEY CHECK ("revision" > 0),
  "requestId" TEXT NOT NULL UNIQUE,
  "operatorId" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('enter', 'resume', 'force-stop')),
  "expectedRevision" INTEGER NOT NULL CHECK ("expectedRevision" >= 0),
  "active" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("revision" = "expectedRevision" + 1),
  CHECK ("active" = ("action" <> 'resume'))
);

-- Cooperative continuation and force-stop intent stay on the original run.
-- Neither column clears ordinary approval, usage, deadline or routine holds.
ALTER TABLE "runs" ADD COLUMN "maintenanceCheckpoint" TEXT;
ALTER TABLE "runs" ADD COLUMN "maintenanceCancelRequestedAt" TIMESTAMP(3);
CREATE INDEX "runs_maintenance_cancel_pending_idx"
  ON "runs" ("maintenanceCancelRequestedAt", "id")
  WHERE "maintenanceCancelRequestedAt" IS NOT NULL;
CREATE INDEX "runs_maintenance_paused_idx"
  ON "runs" ("id") WHERE "status" = 'maintenance_paused';

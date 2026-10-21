ALTER TABLE "external_effects" ADD COLUMN "sourceMessageId" TEXT;
CREATE INDEX "external_effects_spaceId_sourceMessageId_status_idx" ON "external_effects"("spaceId", "sourceMessageId", "status");

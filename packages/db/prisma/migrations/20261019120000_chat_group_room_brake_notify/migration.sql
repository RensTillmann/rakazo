-- Fleet: room brake (pause after the daily run budget) and per-room push.
ALTER TABLE "chat_groups" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "chat_groups" ADD COLUMN "budgetResetAt" TIMESTAMP(3);
ALTER TABLE "chat_groups" ADD COLUMN "budgetResumes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "chat_groups" ADD COLUMN "notify" BOOLEAN NOT NULL DEFAULT false;

-- Fleet: manual prerequisites the user chose to do themselves from a decision card.
-- Intent and verification evidence only; never an approval or a pause release.
CREATE TABLE "user_todos" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "groupTitle" TEXT NOT NULL,
    "release" TEXT NOT NULL DEFAULT 'all' CHECK ("release" IN ('each', 'all')),
    "requirementKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "steps" TEXT NOT NULL,
    "why" TEXT,
    "verification" TEXT NOT NULL CHECK ("verification" IN ('automatic', 'manual')),
    "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'checking', 'verified', 'remaining', 'unavailable', 'confirmed', 'retired')),
    "statusDetail" TEXT,
    "evidence" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "checkRequestedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "releasedRevision" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_todos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_todos_spaceId_userId_status_idx" ON "user_todos"("spaceId", "userId", "status");

CREATE INDEX "user_todos_sourceMessageId_idx" ON "user_todos"("sourceMessageId");

CREATE UNIQUE INDEX "user_todos_spaceId_requirementKey_key" ON "user_todos"("spaceId", "requirementKey");

ALTER TABLE "user_todos" ADD CONSTRAINT "user_todos_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_todos" ADD CONSTRAINT "user_todos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_todos" ADD CONSTRAINT "user_todos_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_todos" ADD CONSTRAINT "user_todos_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

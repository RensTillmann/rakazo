-- Fleet: a to-do belongs to its tracker case by number, not by the card's text.
ALTER TABLE "user_todos" ADD COLUMN "caseRef" INTEGER;

-- Structured blocks ({ "issue": 142, "label": "…" }) next to display text; existing text stays text.
ALTER TABLE "user_todos" ALTER COLUMN "blocks" DROP DEFAULT;
ALTER TABLE "user_todos"
  ALTER COLUMN "blocks" TYPE JSONB USING to_jsonb(COALESCE("blocks", ARRAY[]::TEXT[]));
ALTER TABLE "user_todos" ALTER COLUMN "blocks" SET DEFAULT '[]'::jsonb;
ALTER TABLE "user_todos" ALTER COLUMN "blocks" SET NOT NULL;

-- Backfill only an exact card head: "Case <n> · " or "URGENT · Case <n> · ". Anything else stays
-- NULL rather than guessed from free text.
UPDATE "user_todos"
SET "caseRef" = substring("groupTitle" FROM '^(?:URGENT · )?Case ([1-9][0-9]{0,8}) · ')::INTEGER
WHERE "groupTitle" ~ '^(URGENT · )?Case [1-9][0-9]{0,8} · ';

CREATE INDEX "user_todos_spaceId_caseRef_idx" ON "user_todos"("spaceId", "caseRef");

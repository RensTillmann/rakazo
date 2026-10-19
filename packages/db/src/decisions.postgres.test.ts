import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { listPendingDecisions, pendingDecisionCountsByThread } from "./decisions.js";

// Temporary synthetic tables shadow product tables. Never inspect existing chat content.
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;
postgres("pending decisions (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const actor = { spaceId: "space-1", userId: "user-1" };
  const ask = (status: "pending" | "answered", text = "Send it?") =>
    JSON.stringify([{ kind: "ask", text, status }]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE bots (id text PRIMARY KEY, "spaceId" text, "userId" text, name text, "archivedAt" timestamptz);
      CREATE TEMP TABLE chat_groups (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamptz);
      CREATE TEMP TABLE threads (id text PRIMARY KEY, "spaceId" text, "userId" text, "botId" text, "groupId" text,
        "externalConversationId" text);
      CREATE TEMP TABLE runs (id text PRIMARY KEY, "spaceId" text, "userId" text, "threadId" text, "botId" text,
        status text, "createdAt" timestamptz);
      CREATE TEMP TABLE messages (id text PRIMARY KEY, "threadId" text, seq integer, role text, "botId" text,
        "runId" text, "createdAt" timestamptz, blocks jsonb);
      INSERT INTO bots VALUES
        ('josy','space-1','user-1','Josy',NULL),
        ('lily','space-1','user-1','Lily',NULL),
        ('gone','space-1','user-1','Gone','2026-01-01'),
        ('other','space-1','user-2','Other',NULL);
      INSERT INTO chat_groups VALUES ('room','space-1','user-1',NULL);
      INSERT INTO threads VALUES
        ('t-josy','space-1','user-1','josy',NULL,NULL),
        ('t-lily','space-1','user-1','lily',NULL,NULL),
        ('t-gone','space-1','user-1','gone',NULL,NULL),
        ('t-other','space-1','user-2','other',NULL,NULL),
        ('t-room','space-1','user-1',NULL,'room',NULL);
      INSERT INTO runs VALUES
        ('r-josy-wait','space-1','user-1','t-josy','josy','waiting_input','2026-01-01'),
        ('r-josy-run','space-1','user-1','t-josy','josy','running','2026-01-01'),
        ('r-lily-wait','space-1','user-1','t-lily','lily','waiting_input','2026-01-01'),
        ('r-room-wait','space-1','user-1','t-room','josy','waiting_input','2026-01-01'),
        ('r-gone-wait','space-1','user-1','t-gone','gone','waiting_input','2026-01-01'),
        ('r-other-wait','space-1','user-2','t-other','other','waiting_input','2026-01-01'),
        ('r-done','space-1','user-1','t-lily','lily','completed','2026-01-01');
      INSERT INTO messages VALUES
        ('m-josy-1','t-josy',1,'bot','josy','r-josy-wait','2026-01-01T10:05:00Z','${ask("pending")}'),
        ('m-josy-old','t-josy',2,'bot','josy','r-josy-wait','2026-01-01T10:00:00Z','${ask("answered")}'),
        ('m-josy-run','t-josy',3,'bot','josy','r-josy-run','2026-01-01T09:00:00Z','${ask("pending")}'),
        ('m-lily','t-lily',1,'bot','lily','r-lily-wait','2026-01-01T09:30:00Z','${ask("pending")}'),
        ('m-lily-done','t-lily',2,'bot','lily','r-done','2026-01-01T08:00:00Z','${ask("pending")}'),
        ('m-room','t-room',1,'bot','josy','r-room-wait','2026-01-01T11:00:00Z','${ask("pending")}'),
        ('m-gone','t-gone',1,'bot','gone','r-gone-wait','2026-01-01T07:00:00Z','${ask("pending")}'),
        ('m-other','t-other',1,'bot','other','r-other-wait','2026-01-01T07:00:00Z','${ask("pending")}'),
        ('m-text','t-lily',3,'bot','lily','r-lily-wait','2026-01-01T09:00:00Z','[{"kind":"text","text":"hi"}]');
    `);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("lists only pending cards of waiting runs the user can answer, oldest first", async () => {
    const decisions = await listPendingDecisions(prisma, actor);
    expect(decisions.map((decision) => decision.messageId)).toEqual([
      "m-lily",
      "m-josy-1",
      "m-room",
    ]);
    expect(decisions[0]).toMatchObject({
      runId: "r-lily-wait",
      botId: "lily",
      botName: "Lily",
      groupId: null,
      threadId: "t-lily",
      block: { kind: "ask", status: "pending" },
    });
    expect(decisions[2]).toMatchObject({ groupId: "room", threadId: "t-room", botName: "Josy" });
  });

  it("does not list another user's cards", async () => {
    const decisions = await listPendingDecisions(prisma, { spaceId: "space-1", userId: "user-2" });
    expect(decisions.map((decision) => decision.messageId)).toEqual(["m-other"]);
  });

  it("counts pending cards per chat while a run is busy beside them", async () => {
    const counts = await pendingDecisionCountsByThread(prisma, ["t-josy", "t-lily", "t-room"]);
    expect(Object.fromEntries(counts)).toEqual({ "t-josy": 1, "t-lily": 1, "t-room": 1 });
  });
});

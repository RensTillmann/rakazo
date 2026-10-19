import { isRoutineLogRun } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

/** Fleet patch: routine name by run id, for the runs among `runIds` whose output is routine log. */
export async function routineLogRunNames(
  prisma: PrismaClient | Prisma.TransactionClient,
  runIds: readonly string[],
): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const runs = await prisma.run.findMany({
    where: { id: { in: [...runIds] }, trigger: { in: ["routine", "webhook"] }, routineId: { not: null } },
    select: { id: true, trigger: true, routineId: true, routine: { select: { name: true } } },
  });
  return new Map(
    runs.flatMap((run) =>
      isRoutineLogRun(run) && run.routine ? [[run.id, run.routine.name] as const] : [],
    ),
  );
}
